import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveNotice } from "@/components/ui/save-notice";
import { ToastProvider, useToast } from "@/components/ui/toast";

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success("保存しました。")}>
        成功
      </button>
      <button type="button" onClick={() => toast.error("保存できませんでした。")}>
        失敗
      </button>
    </>
  );
}

function NoticeHost() {
  const [message, setMessage] = useState("");
  return (
    <>
      <button type="button" onClick={() => setMessage("登録しました。")}>
        登録
      </button>
      <SaveNotice message={message} />
    </>
  );
}

describe("ToastProvider / useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("成功は role=status・aria-live=polite で出る", () => {
    render(
      <ToastProvider>
        <Buttons />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "成功" }).click());
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("保存しました。");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("失敗は role=alert で出る", () => {
    render(
      <ToastProvider>
        <Buttons />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "失敗" }).click());
    expect(screen.getByRole("alert")).toHaveTextContent("保存できませんでした。");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("画面の上に固定され、5 秒で消える", () => {
    render(
      <ToastProvider>
        <Buttons />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "成功" }).click());
    const status = screen.getByRole("status");
    expect(status.parentElement?.className).toContain("fixed");
    expect(status.parentElement?.className).toContain("top-");

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("複数の知らせを同時に出し、それぞれ 5 秒で消える", () => {
    render(
      <ToastProvider>
        <Buttons />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "成功" }).click());
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    act(() => screen.getByRole("button", { name: "失敗" }).click());
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("Provider の外で useToast を呼ぶと分かる例外になる", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Buttons />)).toThrow("ToastProvider");
    spy.mockRestore();
  });
});

describe("SaveNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("空の文字列のときは何も出さず、文言が入ると知らせを出す", () => {
    render(
      <ToastProvider>
        <NoticeHost />
      </ToastProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "登録" }).click());
    expect(screen.getByRole("status")).toHaveTextContent("登録しました。");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
