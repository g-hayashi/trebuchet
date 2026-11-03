import { useEffect } from "react";
import { useToast } from "@/components/ui/toast";

/**
 * 保存・登録に成功したことの知らせ（「保存しました。」など）。画面の上の知らせ（toast）として出す。
 * 空の文字列のときは何も出さない。呼び出し側は文言を空にしてから入れ直すと、同じ文言でも出し直せる
 */
export function SaveNotice({ message }: { message: string }) {
  const toast = useToast();
  useEffect(() => {
    if (message) toast.success(message);
  }, [message, toast]);
  return null;
}
