import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast";

/**
 * 保存・登録に成功したことの知らせ（「保存しました。」など）。画面の上の知らせ（toast）として出す。
 * 空の文字列のときは何も出さない。呼び出し側は文言を空にしてから入れ直すと、同じ文言でも出し直せる。
 * 最後に出した文言を覚え、同じ文言では二度出さない（StrictMode は effect を 2 回走らせるが、ref は保たれる）
 */
export function SaveNotice({ message }: { message: string }) {
  const toast = useToast();
  const shown = useRef("");
  useEffect(() => {
    if (!message) {
      shown.current = "";
    } else if (shown.current !== message) {
      shown.current = message;
      toast.success(message);
    }
  }, [message, toast]);
  return null;
}
