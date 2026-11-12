import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

/**
 * デバウンスや「N 秒後に保存」を、実時間を待たずに進める仮想の時計。
 * Date と setTimeout を偽にする。`shouldAdvanceTime` で仮想の時計も実時間と一緒に少しずつ進むため、
 * TanStack Query の setTimeout(0) など、仮想の時計を進めない処理も止まらない。
 */
export function useFakeClock(now?: string) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  if (now !== undefined) vi.setSystemTime(new Date(now));
}

/** 仮想の時計を `ms` 進め、その間に起きる更新と保留の Promise を流す */
export const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** 仮想の時計と組む userEvent（入力ごとの待ちを仮想の時計で進める） */
export const fakeClockUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
