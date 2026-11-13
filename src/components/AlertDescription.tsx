import { For } from "solid-js";

/** Operator text with the safe links retained by the advisory adapters. */
export function AlertDescription(props: { text: string }) {
  const parts = () => props.text.split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gu);
  return (
    <For each={parts()}>
      {(part) => {
        const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/u.exec(part);
        return link ? (
          <a
            href={link[2]}
            target="_blank"
            rel="noopener noreferrer"
            class="text-info underline break-words"
          >
            {link[1]}
          </a>
        ) : (
          part
        );
      }}
    </For>
  );
}
