/** 保存・登録に成功したことの知らせ（「保存しました。」など）。空の文字列のときは何も出さない */
export function SaveNotice({ message }: { message: string }) {
  return (
    <span role="status" className="text-sm">
      {message}
    </span>
  );
}
