import { type ComponentProps, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

/** Grow with the document so editing never creates a second vertical scrollbar. */
export function GrowingTextarea({ value, onValueChange, className, ...props }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<number | null>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    };
    resize();
    if (selection.current !== null) {
      textarea.setSelectionRange(selection.current, selection.current);
      selection.current = null;
    }
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth !== width) {
        width = textarea.clientWidth;
        resize();
      }
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);

  return (
    <textarea
      {...props}
      ref={ref}
      value={value}
      className={cn("clipper-textarea", className)}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !props.readOnly && !props.disabled) {
          event.preventDefault();
          const target = event.currentTarget;
          selection.current = target.selectionStart + 1;
          onValueChange(`${value.slice(0, target.selectionStart)}\n${value.slice(target.selectionEnd)}`);
        }
      }}
    />
  );
}
