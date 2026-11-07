import { useQuery } from "@tanstack/react-query";
import {
  STATEMENT_AMOUNT_SIGNS,
  STATEMENT_COLUMN_ROLES,
  STATEMENT_DELIMITERS,
  STATEMENT_ENCODINGS,
  type StatementAmountSign,
  type StatementColumnIndexes,
  type StatementColumnMapping,
  type StatementColumnRole,
  type StatementColumnSuggestionOptions,
  type StatementDelimiter,
  type StatementEncoding,
  type StatementSource,
  type StatementTableLayout,
} from "@trebuchet/schema";
import { useCallback, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { thisYear } from "@/lib/dates";
import { statementAccountsQuery } from "./api";
import {
  type ColumnAiSuggestion,
  ColumnSuggestionNote,
  needsColumnSuggestion,
} from "./ColumnSuggestionNote";
import { AMOUNT_SIGN_LABELS, DELIMITER_LABELS, ENCODING_LABELS, ROLE_LABELS } from "./labels";
import { HeaderDiff, SourceSelect } from "./SourcePicker";
import type { StatementInputValue } from "./StatementInput";

/** 「確認へ」で渡す、取込の指定（プレビューの options の元） */
export type ColumnMappingDraft = {
  mapping: StatementColumnMapping;
  year: number;
  fixedAccountName?: string | undefined;
  /** 取込元の保存（`id` があれば更新）。名前が空なら null（保存しない） */
  saveSource: { id?: string | undefined; name: string } | null;
};

/** 読み取りの選び直し。`encoding` が undefined なら自動の判定 */
export type RelayoutChoice = {
  delimiter: StatementDelimiter;
  headerRow: number | null;
  encoding?: StatementEncoding | undefined;
};

type Role = StatementColumnRole | "";
type AmountMode = "single" | "double";

const NEW_ACCOUNT = "new";
const accountChoiceOf = (name: string) => `name:${name}`;

/** 見出しなし・見出しが空の列は「列 1」「列 2」… */
const columnName = (header: string[] | null, index: number) =>
  header?.[index]?.trim() || `列 ${index + 1}`;

/** 金額の列の数に合わせた、選べる役割（金額は 1 列のときだけ、出金・入金は 2 列のときだけ） */
const rolesFor = (mode: AmountMode): StatementColumnRole[] =>
  STATEMENT_COLUMN_ROLES.filter((r) =>
    mode === "single" ? r !== "outflow" && r !== "inflow" : r !== "amount",
  );

const initialRoles = (layout: StatementTableLayout, columns: StatementColumnIndexes): Role[] => {
  const roles: Role[] = Array.from({ length: layout.columnCount }, () => "");
  for (const [role, index] of Object.entries(columns)) {
    if (index !== undefined && index < roles.length) roles[index] = role as StatementColumnRole;
  }
  return roles;
};

/**
 * 列の対応（US1）: 見本の表の列ごとに役割を選ぶ。金額は 1 列か出金・入金の 2 列で、1 列なら符号の向きを選ぶ。
 * 区切り・見出しの行・文字コードの選び直しは `onRelayout`（判定のやり直し）。年は年のない日付（`needsYear`）のときだけ、
 * 口座名の列がなければ取込の口座（既存の口座か新しい名前）を聞く。必須がそろわないときは理由を示して `onConfirm` を呼ばせない。
 * 判定のやり直しで `layout` が変わったら、呼び出し側が `key` を変えて作り直す。
 *
 * 取込元（US2）: `initial` があれば、その取込元の対応（役割・符号・口座名・取込元の名前）から始め、保存は更新（id つき）。
 * `sources` があれば既存の取込元を選べる（`onPickSource` で、その取込元の署名で判定をやり直す。`pickedSourceId` は選んだ取込元で、
 * 符号・名前を引き継ぎ、保存は更新）。取込元の名前は、口座名の列がなければ取込の口座の名前が既定。空なら保存しない
 */
export function ColumnMappingEditor({
  entityId,
  layout,
  encodingOverride,
  input,
  pending,
  sources,
  pickedSourceId,
  initial,
  primary = true,
  onRelayout,
  onPickSource,
  onConfirm,
}: {
  /** 画面の主な操作か（variant=default）。プレビューができたら outline にする */
  primary?: boolean;
  entityId: string;
  layout: StatementTableLayout;
  encodingOverride: StatementEncoding | undefined;
  /** 読み取った入力。AI の案の要求が同じファイルを送る */
  input: StatementInputValue | undefined;
  pending: boolean;
  sources: StatementSource[];
  pickedSourceId: string | undefined;
  /** 列の対応を直す取込元と、そのときの対象の年 */
  initial: { source: StatementSource; year: number } | undefined;
  onRelayout: (choice: RelayoutChoice) => void;
  onPickSource: (id: string | undefined) => void;
  onConfirm: (draft: ColumnMappingDraft) => void;
}) {
  const id = useId();
  const accounts = useQuery(statementAccountsQuery(entityId));
  const picked = sources.find((s) => s.id === pickedSourceId);
  /** 初期値のもとにする取込元（直す取込元、なければ選んだ取込元の符号・名前） */
  const base = initial?.source ?? picked;
  const initialColumns = initial?.source.mapping.columns ?? layout.suggestedColumns;

  const [roles, setRoles] = useState<Role[]>(() => initialRoles(layout, initialColumns));
  const [mode, setMode] = useState<AmountMode>(() =>
    initialColumns.outflow !== undefined || initialColumns.inflow !== undefined
      ? "double"
      : "single",
  );
  // 符号の初期値: 取込元の符号、なければ見出しから決まる案（カードの「ご利用額」は出金が正。007/R16）。案も取込元もなければ利用者が選ぶ
  const [sign, setSign] = useState<StatementAmountSign | "">(
    base?.mapping.amountSign ?? layout.suggestedAmountSign ?? "",
  );
  const [year, setYear] = useState(String(initial?.year ?? thisYear()));
  const fixedOfBase = initial?.source.fixedAccountName ?? null;
  const [accountChoice, setAccountChoice] = useState(
    fixedOfBase === null ? "" : accountChoiceOf(fixedOfBase),
  );
  const [newAccountName, setNewAccountName] = useState("");
  const [sourceNameInput, setSourceNameInput] = useState<string | undefined>();

  const [delimiter, setDelimiter] = useState<StatementDelimiter>(layout.delimiter);
  const [headerRowText, setHeaderRowText] = useState(
    layout.headerRow === null ? "" : String(layout.headerRow + 1),
  );
  const [encoding, setEncoding] = useState<StatementEncoding | "">(encodingOverride ?? "");

  // AI の案（US4）は、利用者がまだ触っていない列にだけ入れる
  const touchedColumns = useRef(new Set<number>());
  const modeTouched = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const applySuggestion = useCallback((suggestion: ColumnAiSuggestion) => {
    const entries = Object.entries(suggestion.columns) as [StatementColumnRole, number][];
    const wantsSplit = entries.some(([r]) => r === "outflow" || r === "inflow");
    const wantsSingle = entries.some(([r]) => r === "amount");
    const nextMode: AmountMode = modeTouched.current
      ? modeRef.current
      : wantsSplit
        ? "double"
        : wantsSingle
          ? "single"
          : modeRef.current;
    setMode(nextMode);
    const usable = rolesFor(nextMode);
    setRoles((prev) => {
      const next = [...prev];
      // 利用者が選んだ・選び直した列は変えない。モードで使えなくなった役割は外す
      for (const [i, r] of next.entries()) {
        if (r !== "" && !usable.includes(r) && !touchedColumns.current.has(i)) next[i] = "";
      }
      for (const [role, index] of entries) {
        if (index >= next.length || touchedColumns.current.has(index) || !usable.includes(role)) {
          continue;
        }
        // 利用者が同じ役割を別の列に選んでいれば、案は入れない
        if (next.some((r, i) => r === role && touchedColumns.current.has(i))) continue;
        for (const [i, r] of next.entries()) {
          if (r === role && i !== index) next[i] = "";
        }
        next[index] = role;
      }
      return next;
    });
  }, []);
  const suggestionOptions: StatementColumnSuggestionOptions = {
    origin: input?.origin ?? "paste",
    encoding: layout.encoding,
    delimiter: layout.delimiter,
    headerRow: layout.headerRow,
  };
  const wantsSuggestion =
    input !== undefined && initial === undefined && needsColumnSuggestion(layout);

  const columnOf = (role: StatementColumnRole) => {
    const index = roles.indexOf(role);
    return index < 0 ? undefined : index;
  };
  const hasAccountColumn = columnOf("accountName") !== undefined;
  const yearNumber = Number(year);
  const yearValid = Number.isInteger(yearNumber) && yearNumber >= 1900 && yearNumber <= 9999;
  const fixedAccountName =
    accountChoice === NEW_ACCOUNT
      ? newAccountName.trim()
      : accountChoice.startsWith("name:")
        ? accountChoice.slice("name:".length)
        : "";
  const saveId = initial?.source.id ?? pickedSourceId;
  const defaultSourceName = base?.name ?? (hasAccountColumn ? "" : fixedAccountName);
  const sourceName = (sourceNameInput ?? defaultSourceName).trim();
  const headerRowNumber = headerRowText.trim() === "" ? null : Number(headerRowText);
  const headerRowValid =
    headerRowNumber === null || (Number.isInteger(headerRowNumber) && headerRowNumber >= 1);

  /** 確認へ進めない理由 */
  const reasons: string[] = [];
  for (const role of rolesFor(mode)) {
    if (roles.filter((r) => r === role).length > 1) {
      reasons.push(`「${ROLE_LABELS[role]}」が複数の列に選ばれています`);
    }
  }
  if (columnOf("date") === undefined) reasons.push("「日付」の列を選んでください");
  if (columnOf("content") === undefined) reasons.push("「内容」の列を選んでください");
  if (mode === "single") {
    if (columnOf("amount") === undefined) reasons.push("「金額」の列を選んでください");
    else if (sign === "") reasons.push("金額の符号（正の値が入金か出金か）を選んでください");
  } else {
    const outflow = columnOf("outflow") !== undefined;
    const inflow = columnOf("inflow") !== undefined;
    if (!outflow && !inflow) reasons.push("「出金」と「入金」の列を選んでください");
    else if (!outflow) reasons.push("「出金」の列を選んでください");
    else if (!inflow) reasons.push("「入金」の列を選んでください");
  }
  if (layout.needsYear && !yearValid) reasons.push("対象の年を 4 桁で入力してください");
  if (!hasAccountColumn && fixedAccountName === "") {
    reasons.push("取込の口座を選ぶか、新しい口座の名前を入れてください");
  }

  const changeMode = (next: AmountMode) => {
    modeTouched.current = true;
    setMode(next);
    // 使えなくなった役割の選択を外す
    setRoles((prev) => prev.map((r) => (r !== "" && !rolesFor(next).includes(r) ? "" : r)));
  };

  const confirm = () => {
    const columns: StatementColumnMapping["columns"] = {};
    roles.forEach((role, index) => {
      if (role !== "") columns[role] = index;
    });
    onConfirm({
      mapping: {
        delimiter: layout.delimiter,
        headerRow: layout.headerRow,
        columns,
        ...(mode === "single" && sign !== "" ? { amountSign: sign } : {}),
      },
      year: layout.needsYear ? yearNumber : thisYear(),
      ...(hasAccountColumn ? {} : { fixedAccountName }),
      saveSource:
        sourceName === ""
          ? null
          : { ...(saveId === undefined ? {} : { id: saveId }), name: sourceName },
    });
  };

  const indexes = Array.from({ length: layout.columnCount }, (_, i) => i);

  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">
        {layout.rowCount}{" "}
        行を読み取りました。列ごとに役割を選びます（日付・内容と、金額または出金・入金が必要です）。
      </p>

      {wantsSuggestion && input && (
        <ColumnSuggestionNote
          entityId={entityId}
          file={input.file}
          options={suggestionOptions}
          onSuggestion={applySuggestion}
        />
      )}

      {layout.headerDiff && (
        <HeaderDiff added={layout.headerDiff.added} removed={layout.headerDiff.removed} />
      )}

      {initial === undefined && sources.length > 0 && (
        <SourceSelect
          sources={sources}
          value={pickedSourceId}
          disabled={pending}
          onChange={onPickSource}
        />
      )}

      <fieldset className="flex flex-wrap items-end gap-4">
        <legend className="mb-1 text-sm font-medium">読み取りの設定</legend>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-delimiter`}>区切り文字</Label>
          <NativeSelect
            id={`${id}-delimiter`}
            className="w-36"
            value={delimiter}
            onChange={(e) => setDelimiter(e.target.value as StatementDelimiter)}
          >
            {STATEMENT_DELIMITERS.map((d) => (
              <option key={d} value={d}>
                {DELIMITER_LABELS[d]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-header-row`}>見出しの行</Label>
          <Input
            id={`${id}-header-row`}
            type="number"
            min={1}
            inputMode="numeric"
            className="w-28"
            placeholder="なし"
            aria-describedby={`${id}-header-row-hint`}
            value={headerRowText}
            onChange={(e) => setHeaderRowText(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-encoding`}>文字コード</Label>
          <NativeSelect
            id={`${id}-encoding`}
            className="w-44"
            value={encoding}
            onChange={(e) => setEncoding(e.target.value as StatementEncoding | "")}
          >
            <option value="">自動</option>
            {STATEMENT_ENCODINGS.map((enc) => (
              <option key={enc} value={enc}>
                {ENCODING_LABELS[enc]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !headerRowValid}
          onClick={() =>
            onRelayout({
              delimiter,
              headerRow: headerRowNumber === null ? null : headerRowNumber - 1,
              ...(encoding === "" ? {} : { encoding }),
            })
          }
        >
          読み直す
        </Button>
        <p id={`${id}-header-row-hint`} className="basis-full text-xs text-muted-foreground">
          見出しの行は、前置きの行も数えた行の番号です。空にすると、見出しなしで読みます。
        </p>
      </fieldset>

      <Table aria-label="見本の表">
        <TableHeader>
          <TableRow>
            {indexes.map((i) => (
              <TableHead key={i}>{columnName(layout.header, i)}</TableHead>
            ))}
          </TableRow>
          <TableRow>
            {indexes.map((i) => {
              const name = columnName(layout.header, i);
              return (
                <TableCell key={i}>
                  <NativeSelect
                    aria-label={`「${name}」の役割`}
                    value={roles[i] ?? ""}
                    onChange={(e) => {
                      touchedColumns.current.add(i);
                      setRoles((prev) =>
                        prev.map((r, index) => (index === i ? (e.target.value as Role) : r)),
                      );
                    }}
                  >
                    <option value="">使わない</option>
                    {rolesFor(mode).map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </NativeSelect>
                </TableCell>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {layout.sampleRows.map((cells, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 見本の行は並びが固定で、同じ内容の行がありうる
            <TableRow key={rowIndex}>
              {indexes.map((i) => (
                <TableCell key={i} className="whitespace-nowrap">
                  {cells[i] ?? ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex flex-wrap gap-8">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">金額の列</legend>
          {(
            [
              ["single", "金額は 1 列"],
              ["double", "出金・入金の 2 列"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-mode`}
                checked={mode === value}
                onChange={() => changeMode(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {mode === "single" && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">金額の符号</legend>
            {STATEMENT_AMOUNT_SIGNS.map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-sign`}
                  checked={sign === value}
                  onChange={() => setSign(value)}
                />
                {AMOUNT_SIGN_LABELS[value]}
              </label>
            ))}
          </fieldset>
        )}

        {layout.needsYear && (
          <div className="grid content-start gap-1">
            <Label htmlFor={`${id}-year`}>対象の年</Label>
            <Input
              id={`${id}-year`}
              type="number"
              inputMode="numeric"
              className="w-28"
              aria-invalid={yearValid ? undefined : true}
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              日付に年が含まれていない明細に使います。
            </p>
          </div>
        )}

        {!hasAccountColumn && (
          <div className="grid content-start gap-2">
            <div className="grid gap-1">
              <Label htmlFor={`${id}-account`}>取込の口座</Label>
              <NativeSelect
                id={`${id}-account`}
                className="w-64"
                value={accountChoice}
                onChange={(e) => setAccountChoice(e.target.value)}
              >
                <option value="">選んでください</option>
                {accounts.data?.map((a) => (
                  <option key={a.id} value={accountChoiceOf(a.name)}>
                    {a.name}
                  </option>
                ))}
                {/* 直す取込元の口座が、まだ口座の対応のない名前のとき（一覧にない）も選べる */}
                {fixedOfBase !== null && !accounts.data?.some((a) => a.name === fixedOfBase) && (
                  <option value={accountChoiceOf(fixedOfBase)}>{fixedOfBase}</option>
                )}
                <option value={NEW_ACCOUNT}>新しい名前を入れる</option>
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                口座名の列を選ばないときは、この明細の口座を選びます。
              </p>
            </div>
            {accountChoice === NEW_ACCOUNT && (
              <div className="grid gap-1">
                <Label htmlFor={`${id}-account-name`}>口座の名前</Label>
                <Input
                  id={`${id}-account-name`}
                  className="w-64"
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-1">
        <Label htmlFor={`${id}-source-name`}>取込元の名前</Label>
        <Input
          id={`${id}-source-name`}
          autoComplete="off"
          maxLength={100}
          className="w-64"
          value={sourceNameInput ?? defaultSourceName}
          onChange={(e) => setSourceNameInput(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          名前をつけて取り込むと、この列の対応を保存し、次回から同じ形の明細に自動で当てはめます。空にすると保存しません。
        </p>
      </div>

      {reasons.length > 0 && (
        <ul
          aria-label="確認へ進めない理由"
          className="list-disc pl-5 text-sm text-muted-foreground"
        >
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <div>
        <Button
          type="button"
          variant={primary ? "default" : "outline"}
          disabled={pending || reasons.length > 0}
          onClick={confirm}
        >
          確認へ
        </Button>
      </div>
    </div>
  );
}
