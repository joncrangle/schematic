export interface ToggleSwitchProps {
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly label?: string;
  readonly id?: string;
  readonly disabled?: boolean;
}

export function ToggleSwitch(props: ToggleSwitchProps) {
  return (
    <button
      type="button"
      id={props.id}
      role="switch"
      aria-checked={props.checked ? "true" : "false"}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) props.onChange();
      }}
      class={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200 ease-in-out focus:outline-none ${
        props.disabled ? "opacity-50 cursor-not-allowed" : ""
      } ${props.checked ? "bg-live" : "bg-accent"}`}
    >
      <span
        aria-hidden="true"
        class={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out ${
          props.checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}
