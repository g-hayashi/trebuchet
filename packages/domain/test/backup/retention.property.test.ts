import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { selectBackupsToPrune } from "../../src/backup/retention.ts";
import type { BackupFileInfo } from "../../src/backup/types.ts";

const DAY = 24 * 60 * 60 * 1000;
const MAC = "abcd1234";
const OTHER_MACS = ["ffff0000", "12345678"];

// 2015-01-01 〜 2035-01-01（ミリ秒）
const timeArb = fc.integer({ min: 1_420_070_400_000, max: 2_050_000_000_000 });
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (ms: number) => iso(ms).slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

// 名前は一意にする（同じ時刻でも違うファイル）
const filesArb = (nowMs: number) =>
  fc
    .array(
      fc.record({
        macId: fc.constantFrom(MAC, ...OTHER_MACS),
        // now の前後に偏らせる: 直近・数か月前・数年前・7年超
        at: fc.oneof(
          fc.integer({ min: nowMs - 40 * DAY, max: nowMs + 2 * DAY }),
          fc.integer({ min: nowMs - 400 * DAY, max: nowMs }),
          fc.integer({ min: nowMs - 8 * 365 * DAY, max: nowMs }),
        ),
      }),
      { maxLength: 60 },
    )
    .map((xs): BackupFileInfo[] =>
      xs.map((x, i) => ({
        name: `trebuchet-${x.macId}-${stamp(x.at)}-${i}.tbk`,
        macId: x.macId,
        createdAt: iso(x.at),
      })),
    );

const scenarioArb = timeArb.chain((nowMs) =>
  filesArb(nowMs).map((files) => ({ nowMs, now: iso(nowMs), files })),
);

const dayKey = (f: BackupFileInfo) => f.createdAt.slice(0, 10);
const monthKey = (f: BackupFileInfo) => f.createdAt.slice(0, 7);
const newest = (fs: BackupFileInfo[]) =>
  fs.reduce((a, b) =>
    b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.name > a.name) ? b : a,
  );
const groupBy = (fs: BackupFileInfo[], key: (f: BackupFileInfo) => string) => {
  const m = new Map<string, BackupFileInfo[]>();
  for (const f of fs) m.set(key(f), [...(m.get(key(f)) ?? []), f]);
  return [...m.values()];
};

/** 保持するファイルの独立した定義（この Mac のものだけ） */
function expectedKept(own: BackupFileInfo[], nowMs: number): Set<string> {
  const kept = new Set<string>();
  if (own.length === 0) return kept;
  const cutoff = new Date(nowMs);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 7);
  const recent = own.filter((f) => nowMs - Date.parse(f.createdAt) < 30 * DAY);
  const older = own.filter(
    (f) =>
      nowMs - Date.parse(f.createdAt) >= 30 * DAY && Date.parse(f.createdAt) >= cutoff.getTime(),
  );
  for (const g of groupBy(recent, dayKey)) kept.add(newest(g).name);
  for (const g of groupBy(older, monthKey)) kept.add(newest(g).name);
  const current = own.reduce((a, b) =>
    Math.abs(Date.parse(b.createdAt) - nowMs) < Math.abs(Date.parse(a.createdAt) - nowMs) ? b : a,
  );
  kept.add(current.name);
  return kept;
}

describe("selectBackupsToPrune（INV-27）", () => {
  it("選ばれるのはこの Mac のファイルだけ", () => {
    fc.assert(
      fc.property(scenarioArb, ({ now, files }) => {
        for (const f of selectBackupsToPrune(files, MAC, now)) expect(f.macId).toBe(MAC);
      }),
    );
  });

  it("ほかの Mac のファイルを選ばない", () => {
    fc.assert(
      fc.property(scenarioArb, ({ now, files }) => {
        const others = new Set(files.filter((f) => f.macId !== MAC).map((f) => f.name));
        for (const f of selectBackupsToPrune(files, MAC, now))
          expect(others.has(f.name)).toBe(false);
      }),
    );
  });

  it("直近30日の各日の最新・7年以内の各月の最新・今回のファイルを選ばない", () => {
    fc.assert(
      fc.property(scenarioArb, ({ now, nowMs, files }) => {
        const pruned = new Set(selectBackupsToPrune(files, MAC, now).map((f) => f.name));
        const own = files.filter((f) => f.macId === MAC);
        const kept = expectedKept(own, nowMs);
        for (const name of kept) expect(pruned.has(name)).toBe(false);
      }),
    );
  });

  it("保持の定義に合わないこの Mac のファイルは、すべて選ばれる", () => {
    fc.assert(
      fc.property(scenarioArb, ({ now, nowMs, files }) => {
        const pruned = new Set(selectBackupsToPrune(files, MAC, now).map((f) => f.name));
        const own = files.filter((f) => f.macId === MAC);
        const kept = expectedKept(own, nowMs);
        for (const f of own) expect(pruned.has(f.name)).toBe(!kept.has(f.name));
      }),
    );
  });

  it("冪等: 選ばれたものを除いた集合にもう一度掛けても何も選ばれない", () => {
    fc.assert(
      fc.property(scenarioArb, ({ now, files }) => {
        const pruned = new Set(selectBackupsToPrune(files, MAC, now).map((f) => f.name));
        const rest = files.filter((f) => !pruned.has(f.name));
        expect(selectBackupsToPrune(rest, MAC, now)).toEqual([]);
      }),
    );
  });

  it("macId は先頭8文字で比べる（長い ID を渡してもよい）", () => {
    const now = "2026-10-20T00:00:00.000Z";
    const files: BackupFileInfo[] = [
      { name: "a", macId: MAC, createdAt: "2026-10-19T01:00:00.000Z" },
      { name: "b", macId: MAC, createdAt: "2026-10-19T02:00:00.000Z" },
    ];
    expect(selectBackupsToPrune(files, `${MAC}-0000-0000`, now).map((f) => f.name)).toEqual(["a"]);
  });

  it("具体例: 同じ日は最新だけ、同じ月は最新だけ、7年超は消す", () => {
    const now = "2026-10-20T12:00:00.000Z";
    const mk = (name: string, createdAt: string): BackupFileInfo => ({
      name,
      macId: MAC,
      createdAt,
    });
    const files = [
      mk("today-1", "2026-10-20T01:00:00.000Z"),
      mk("today-2", "2026-10-20T11:00:00.000Z"),
      mk("sep-1", "2026-09-01T00:00:00.000Z"),
      mk("sep-2", "2026-09-10T00:00:00.000Z"),
      mk("old", "2019-01-01T00:00:00.000Z"),
    ];
    expect(
      selectBackupsToPrune(files, MAC, now)
        .map((f) => f.name)
        .sort(),
    ).toEqual(["old", "sep-1", "today-1"]);
  });

  it("空の集合・この Mac のファイルがなければ何も選ばない", () => {
    expect(selectBackupsToPrune([], MAC, "2026-10-20T00:00:00.000Z")).toEqual([]);
  });
});
