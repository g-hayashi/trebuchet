import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Combobox } from "@/components/ui/combobox";

type Account = { id: string; code: string; name: string };
const accounts: Account[] = [
  { id: "a1", code: "1010", name: "現金" },
  { id: "a2", code: "1020", name: "普通預金" },
  { id: "a3", code: "5210", name: "旅費交通費" },
];
const match = (o: Account, q: string) => o.code.startsWith(q) || o.name.includes(q);

function Host({ onCommit = () => {} }: { onCommit?: (o: Account) => void }) {
  const [value, setValue] = useState<Account | null>(null);
  const next = useRef<HTMLInputElement>(null);
  return (
    <>
      <label htmlFor="debit">借方</label>
      <Combobox
        id="debit"
        options={accounts}
        value={value}
        onChange={setValue}
        match={match}
        getKey={(o) => o.id}
        getLabel={(o) => `${o.code} ${o.name}`}
        onCommit={(o) => {
          onCommit(o);
          next.current?.focus();
        }}
        emptyMessage="該当する科目がありません"
      />
      <label htmlFor="credit">貸方</label>
      <input id="credit" ref={next} />
    </>
  );
}

describe("Combobox", () => {
  it("combobox と listbox の ARIA を持つ", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const input = screen.getByRole("combobox", { name: "借方" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("↑↓ で選び Enter で確定し、次の欄にフォーカスが移る（キーボードだけ）", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);
    await user.tab();
    const input = screen.getByRole("combobox", { name: "借方" });
    expect(input).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    const options = screen.getAllByRole("option");
    // 開いた直後は先頭を選ぶ。↓ でさらに次へ
    expect(input).toHaveAttribute("aria-activedescendant", options[0]?.id);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", options[1]?.id);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]?.id);
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(accounts[1]);
    expect(screen.getByLabelText("貸方")).toHaveFocus();
    expect(input).toHaveValue("1020 普通預金");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("入力で絞り込む（呼ぶ側の match）。先頭の候補が選ばれ、Enter で確定する", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);
    await user.type(screen.getByRole("combobox", { name: "借方" }), "旅費");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(accounts[2]);
    expect(screen.getByLabelText("貸方")).toHaveFocus();
  });

  it("0 件のときは emptyMessage を出し、Enter は何も確定しない", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);
    const input = screen.getByRole("combobox", { name: "借方" });
    await user.type(input, "存在しない");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText("該当する科目がありません")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it("Esc で候補を閉じる。クリックでも選べる", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);
    const input = screen.getByRole("combobox", { name: "借方" });
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("option", { name: "1010 現金" }));
    expect(onCommit).toHaveBeenCalledWith(accounts[0]);
    expect(input).toHaveValue("1010 現金");
  });
});
