import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Steps } from "@/components/ui/steps";

describe("Sheet", () => {
  it("開くと右から出る横のパネルが dialog として出て、Esc で閉じる", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>開く</SheetTrigger>
        <SheetContent>
          <SheetTitle>仕訳の中身</SheetTitle>
          <SheetDescription>詳細</SheetDescription>
          <p>本文</p>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = screen.getByRole("dialog", { name: "仕訳の中身" });
    expect(dialog).toHaveTextContent("本文");
    // 右に固定し、md 未満は全画面、md 以上は幅を絞る
    expect(dialog.className).toContain("right-0");
    expect(dialog.className).toContain("w-full");
    expect(dialog.className).toContain("md:max-w-");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Steps", () => {
  const items = ["入力", "列と口座", "取込", "確認・承認"];

  it("①〜④ を順に出し、今の段階だけ aria-current=step", () => {
    render(<Steps steps={items} current={1} />);
    const list = screen.getByRole("list", { name: "手順" });
    const listItems = screen.getAllByRole("listitem");
    expect(list).toBeInTheDocument();
    expect(listItems).toHaveLength(4);
    expect(listItems[0]).toHaveTextContent("①");
    expect(listItems[0]).toHaveTextContent("入力");
    expect(listItems[3]).toHaveTextContent("④");
    expect(listItems[3]).toHaveTextContent("確認・承認");
    expect(listItems.map((li) => li.getAttribute("aria-current"))).toEqual([
      null,
      "step",
      null,
      null,
    ]);
  });

  it("label で名前を変えられる", () => {
    render(<Steps steps={["作成", "発行"]} current={0} label="請求の手順" />);
    expect(screen.getByRole("list", { name: "請求の手順" })).toBeInTheDocument();
  });
});
