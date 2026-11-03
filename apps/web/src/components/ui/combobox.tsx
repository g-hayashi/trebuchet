import {
  type ComponentProps,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ComboboxProps<T> = {
  options: readonly T[];
  /** 選んでいる値（未選択は null） */
  value: T | null;
  onChange: (value: T | null) => void;
  /** Enter・クリックで確定したとき。次の欄へフォーカスを移すのは呼ぶ側（ref で `focus()`） */
  onCommit?: ((value: T) => void) | undefined;
  /** 絞り込み。入力が空のときは呼ばず、すべての候補を出す */
  match: (option: T, query: string) => boolean;
  getKey: (option: T) => string;
  /** 入力欄と候補に出す文字列（「1010 現金」など） */
  getLabel: (option: T) => string;
  /** 0 件のときの表示 */
  emptyMessage: string;
} & Omit<
  ComponentProps<"input">,
  "value" | "onChange" | "role" | "type" | "children" | "defaultValue"
>;

/** WAI-ARIA の combobox（input + listbox）。↑↓ で選び、Enter で確定、Esc で閉じる */
export function Combobox<T>({
  options,
  value,
  onChange,
  onCommit,
  match,
  getKey,
  getLabel,
  emptyMessage,
  className,
  onBlur,
  onKeyDown,
  onClick,
  ...inputProps
}: ComboboxProps<T>) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const labelOf = (v: T | null) => (v === null ? "" : getLabel(v));
  const [text, setText] = useState(() => labelOf(value));
  // 入力して絞り込んでいる間だけ true。確定したあとに開き直したときは全候補を出す
  const [typing, setTyping] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // 確定の直後に次の欄へ移すと、再描画の前に blur が走る。blur では最新の値をここから読む
  const latestValue = useRef(value);
  latestValue.current = value;
  const latestLabel = useRef(getLabel);
  latestLabel.current = getLabel;

  // 外から値が変わったら（フォームのリセットなど）入力欄の表示を合わせる
  useEffect(() => {
    setText(value === null ? "" : latestLabel.current(value));
    setTyping(false);
  }, [value]);

  const visible = useMemo(
    () => (typing && text !== "" ? options.filter((option) => match(option, text)) : options),
    [options, typing, text, match],
  );
  const activeIndex = Math.min(active, visible.length - 1);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${baseId}-opt-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, baseId]);

  function commit(option: T) {
    latestValue.current = option;
    onChange(option);
    setText(getLabel(option));
    setTyping(false);
    setOpen(false);
    onCommit?.(option);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActive(0);
        } else {
          setActive(Math.min(activeIndex + 1, visible.length - 1));
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActive(0);
        } else {
          setActive(Math.max(activeIndex - 1, 0));
        }
        break;
      case "Enter": {
        // 候補を開いているあいだの Enter は、フォームの送信にしない
        if (!open) break;
        event.preventDefault();
        const option = visible[activeIndex];
        if (option !== undefined) commit(option);
        break;
      }
      case "Escape":
        if (open) {
          // 外側のダイアログ・Sheet まで閉じない
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
        break;
    }
  }

  return (
    <div className="relative">
      <Input
        {...inputProps}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        className={className}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setTyping(true);
          setOpen(true);
          setActive(0);
          if (event.target.value === "" && latestValue.current !== null) {
            latestValue.current = null;
            onChange(null);
          }
        }}
        onClick={(event) => {
          onClick?.(event);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          onBlur?.(event);
          setOpen(false);
          setTyping(false);
          const current = latestValue.current;
          setText(current === null ? "" : latestLabel.current(current));
        }}
      />
      {open &&
        (visible.length > 0 ? (
          <div
            id={listId}
            role="listbox"
            className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          >
            {visible.map((option, index) => (
              // 候補はフォーカスを受けない（フォーカスは入力欄のまま aria-activedescendant で示す）。
              // キーボードの操作は入力欄の onKeyDown が受ける
              // biome-ignore lint/a11y/useFocusableInteractive: combobox の候補は aria-activedescendant で選ぶ
              // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードの操作は入力欄が受ける
              <div
                key={getKey(option)}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                // クリックで入力欄からフォーカスを奪わない（blur で閉じてしまう）
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => commit(option)}
                className={cn(
                  "cursor-pointer rounded-sm px-2 py-1.5",
                  index === activeIndex && "bg-accent text-accent-foreground",
                )}
              >
                {getLabel(option)}
              </div>
            ))}
          </div>
        ) : (
          <div
            id={listId}
            className="absolute z-50 mt-1 w-full rounded-md border bg-popover px-2 py-1.5 text-sm text-muted-foreground shadow-md"
          >
            {emptyMessage}
          </div>
        ))}
    </div>
  );
}
