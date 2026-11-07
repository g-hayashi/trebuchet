import { describe, expect, it } from "vitest";
import { dropMismatchedColumns, inferMissingColumns } from "../../src/statements/column-content.ts";

// 007/R16: 列の案（AI）を、見本の行の値で検査する。合わない役割は捨て、案のない日付・金額・内容は中身から推定する

const ROWS = [
  ["26/10/31", "テスト商店A", "ご本人", "リボ払い", "26/11", "4,100"],
  ["26/10/26", "TEST ONLINE", "ご本人", "リボ払い", "26/11", "1,800"],
  ["26/10/20", "テスト商店B", "ご本人", "リボ払い", "26/11", "3,000"],
];

describe("dropMismatchedColumns: 見本の値で合わない役割を捨てる", () => {
  it("日付の列の過半が日付として読めなければ捨てる", () => {
    expect(dropMismatchedColumns({ date: 1, content: 1 }, ROWS)).toEqual({ content: 1 });
    expect(dropMismatchedColumns({ date: 0 }, ROWS)).toEqual({ date: 0 });
  });

  it("金額・出金・入金の列の過半が金額として読めなければ捨てる（年月・文字は金額ではない）", () => {
    expect(dropMismatchedColumns({ amount: 4 }, ROWS)).toEqual({});
    expect(dropMismatchedColumns({ amount: 3 }, ROWS)).toEqual({});
    expect(dropMismatchedColumns({ amount: 5 }, ROWS)).toEqual({ amount: 5 });
  });

  it("出金・入金は片方が捨てられたら、もう片方も捨てる（対が崩れるため）", () => {
    expect(dropMismatchedColumns({ outflow: 3, inflow: 5 }, ROWS)).toEqual({});
    expect(dropMismatchedColumns({ outflow: 5, inflow: 5 }, ROWS)).toEqual({
      outflow: 5,
      inflow: 5,
    });
  });

  it("過半は「空でないセルのうち」で数える。空のセルは数えず、空でないセルがなければ捨てない", () => {
    const rows = [
      ["2026/10/01", "", "5", "1"],
      ["2026/10/02", "", "", ""],
      ["2026/10/03", "", "7", ""],
      ["2026/10/04", "", "x", "y"],
    ];
    expect(dropMismatchedColumns({ amount: 1 }, rows)).toEqual({ amount: 1 });
    // 空でない 3 つのうち 2 つが読める（空を数えると 2/4 で過半にならない）
    expect(dropMismatchedColumns({ amount: 2 }, rows)).toEqual({ amount: 2 });
    // 空でない 2 つのうち 1 つだけ（過半ではない）
    expect(dropMismatchedColumns({ amount: 3 }, rows)).toEqual({});
  });

  it("日付・金額以外の役割は検査しない。列が行にない（短い行）ときは空のセル扱い", () => {
    expect(dropMismatchedColumns({ content: 0, memo: 3, categoryMajor: 5 }, ROWS)).toEqual({
      content: 0,
      memo: 3,
      categoryMajor: 5,
    });
    expect(dropMismatchedColumns({ amount: 9 }, ROWS)).toEqual({ amount: 9 });
  });

  it("セルの中の改行は 1 行目で金額を判定する（5,000 と (5,000) が改行でつながった形）", () => {
    expect(dropMismatchedColumns({ amount: 0 }, [["5,000\n(5,000)"], ["800\n(800)"]])).toEqual({
      amount: 0,
    });
  });
});

describe("inferMissingColumns: 案のない日付・金額・内容を中身から推定する", () => {
  it("日付は、読める割合が最大で過半の列の最も左。金額は、金額として読める過半の列で日付列でない最も左。内容は文字の列で平均の長さが最大", () => {
    expect(inferMissingColumns({}, ROWS, 6)).toEqual({ date: 0, amount: 5, content: 1 });
  });

  it("すでに案のある役割は推定しない。案の列は使わない", () => {
    expect(inferMissingColumns({ date: 0, content: 1 }, ROWS, 6)).toEqual({ amount: 5 });
    // 金額の案が 5 の列にあれば、内容は 5 を除いた文字の列から
    expect(inferMissingColumns({ date: 0, amount: 5 }, ROWS, 6)).toEqual({ content: 1 });
  });

  it("出金・入金の案があるときは、金額を推定しない", () => {
    expect(inferMissingColumns({ outflow: 5 }, ROWS, 6)).toEqual({ date: 0, content: 1 });
    expect(inferMissingColumns({ inflow: 5 }, ROWS, 6)).toEqual({ date: 0, content: 1 });
  });

  it("日付の列は、読める割合が過半に満たなければ推定しない。割合が同じなら左", () => {
    const rows = [
      ["2026/10/01", "x", "2026/10/02", "-100"],
      ["あ", "y", "2026/10/03", "-200"],
      ["い", "z", "2026/10/04", "-300"],
    ];
    // 0 列は 1/3、2 列は 3/3
    expect(inferMissingColumns({}, rows, 4)).toMatchObject({ date: 2, amount: 3 });
    const same = [
      ["2026/10/01", "2026/10/01", "A"],
      ["2026/10/02", "2026/10/02", "B"],
    ];
    expect(inferMissingColumns({}, same, 3).date).toBe(0);
  });

  it("金額の列は日付として読める列（20261001 のような書き方）を選ばない", () => {
    const rows = [
      ["20261001", "A", "-1,200"],
      ["20261002", "B", "-3,400"],
    ];
    expect(inferMissingColumns({}, rows, 3)).toEqual({ date: 0, amount: 2, content: 1 });
  });

  it("推定できる列がなければ何も足さない", () => {
    expect(inferMissingColumns({}, [["あ", "い"]], 2)).toEqual({ content: 0 });
    expect(inferMissingColumns({}, [], 3)).toEqual({});
  });

  it("日付・金額・内容・出金・入金の案の列は取らない。メモなどの列は取ってよい", () => {
    const rows = [
      ["2026/10/01", "A店", "-100"],
      ["2026/10/02", "B店", "-200"],
    ];
    // 内容の案が 0 列目（誤り）。日付は残りの列から探すが、読める列は 0 列だけで使えない
    expect(inferMissingColumns({ content: 0 }, rows, 3)).toEqual({ amount: 2 });
    // メモ（案）の列にも金額が並ぶなら、金額に取ってよい
    expect(inferMissingColumns({ date: 0, content: 1, memo: 2 }, rows, 3)).toEqual({ amount: 2 });
  });
});
