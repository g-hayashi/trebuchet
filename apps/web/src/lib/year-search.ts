import { YEAR_PATTERN } from "@trebuchet/schema";
import { useState } from "react";
import { z } from "zod";

/** 年分（暦年。個人）の検索パラメーター。不正な値は捨てて、呼び出し側が今年にする */
export const YearSearch = z.object({
  year: z.number().int().min(1900).max(9999).optional().catch(undefined),
});

/**
 * 年分の入力欄。4 桁になったときだけ onYearChange を呼ぶ（入力途中の文字列は欄に残す）。
 * 欄の初期値は最初の year。URL の変更で year が変わっても欄は追従しない
 */
export function useYearInput(year: number, onYearChange: (year: number) => void) {
  const [yearText, setYearText] = useState(String(year));
  const changeYear = (text: string) => {
    setYearText(text);
    if (YEAR_PATTERN.test(text)) onYearChange(Number(text));
  };
  return { yearText, changeYear };
}
