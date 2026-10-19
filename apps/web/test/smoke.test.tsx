import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Button } from "@/components/ui/button";

it("jsdom でコンポーネントを描画して操作できる", async () => {
  let clicked = 0;
  render(<Button onClick={() => clicked++}>保存</Button>);
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(clicked).toBe(1);
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
});
