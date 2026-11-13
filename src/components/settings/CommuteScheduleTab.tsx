import { For, Show, createSignal, untrack } from "solid-js";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import type { CommuteSchedule } from "~/domain/preferences/UserPreferences";
import { ToggleSwitch } from "./ToggleSwitch";
import { PencilIcon } from "../icons/PencilIcon";
import { CheckIcon } from "../icons/CheckIcon";
import { createKeyHandler } from "~/lib/keyboard";
import { usePushAvailability } from "~/hooks/usePushAvailability";
import { useI18n } from "~/i18n/I18nContext";

const DAYS_OF_WEEK = [
  { day: 1, name: "Monday" },
  { day: 2, name: "Tuesday" },
  { day: 3, name: "Wednesday" },
  { day: 4, name: "Thursday" },
  { day: 5, name: "Friday" },
  { day: 6, name: "Saturday" },
  { day: 0, name: "Sunday" },
];

interface CommuteScheduleCardProps {
  schedule: CommuteSchedule;
  canDelete: boolean;
  onUpdate: (id: string, updates: Partial<CommuteSchedule>) => void;
  onRemove: (id: string) => void;
}

function CommuteScheduleCard(props: CommuteScheduleCardProps) {
  const { t, formatLocale, formatTime } = useI18n();
  const [isEditing, setIsEditing] = createSignal(false);
  const [draftLabel, setDraftLabel] = createSignal(untrack(() => props.schedule.label));
  let inputRef: HTMLInputElement | undefined = undefined;

  const weekdayLabel = (day: number) => {
    const date = new Date(Date.UTC(2024, 0, 1 + ((day + 6) % 7)));
    return new Intl.DateTimeFormat(formatLocale(), {
      weekday: "narrow",
      timeZone: "UTC",
    }).format(date);
  };

  const displayTime = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return value;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return value;
    return formatTime(new Date(2024, 0, 1, hour, minute), {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Built-in labels are localized while their stored English values stay
  // intact. Any label riders have edited remains their authored text.
  const displayLabel = () => {
    if (props.schedule.labelSource === "user") return props.schedule.label;
    if (props.schedule.labelSource === "default" && props.schedule.label === "Custom Commute") {
      return t("Custom Commute");
    }
    if (props.schedule.id === "morning_commute" && props.schedule.label === "Morning Commute") {
      return t("Morning Commute");
    }
    if (props.schedule.id === "evening_commute" && props.schedule.label === "Evening Commute") {
      return t("Evening Commute");
    }
    return props.schedule.label;
  };

  const handleStartEdit = () => {
    setDraftLabel(displayLabel());
    setIsEditing(true);
    queueMicrotask(() => {
      if (inputRef) {
        inputRef.focus();
        inputRef.select();
      }
    });
  };

  const handleSave = () => {
    if (!isEditing()) return;
    const trimmed = draftLabel().trim();
    if (trimmed.length > 0) {
      if (trimmed !== displayLabel()) {
        props.onUpdate(props.schedule.id, { label: trimmed, labelSource: "user" });
      }
    } else {
      setDraftLabel(displayLabel());
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setDraftLabel(displayLabel());
    setIsEditing(false);
  };

  const handleKeyDown = createKeyHandler({
    onEnter: handleSave,
    onEscape: handleCancel,
  });

  const handleToggleDay = (dayNum: number) => {
    const nextDays = props.schedule.days.includes(dayNum)
      ? props.schedule.days.filter((d) => d !== dayNum)
      : [...props.schedule.days, dayNum];
    props.onUpdate(props.schedule.id, { days: nextDays });
  };

  return (
    <div class="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
      {/* Header & Toggle */}
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 flex-1 flex-col">
          <Show
            when={isEditing()}
            fallback={
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[13px] font-semibold text-white">{displayLabel()}</span>
                <button
                  type="button"
                  aria-label={t("Edit {{name}} name", { name: displayLabel() })}
                  onClick={handleStartEdit}
                  class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-white"
                >
                  <PencilIcon size={12} />
                </button>
              </div>
            }
          >
            <div class="flex items-center gap-1">
              <input
                ref={(el) => {
                  inputRef = el;
                }}
                type="text"
                value={draftLabel()}
                aria-label={t("Edit name for {{name}}", { name: displayLabel() })}
                onInput={(e) => setDraftLabel(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSave}
                class="w-full max-w-40 rounded border border-info bg-card px-1.5 py-0.5 text-[13px] font-semibold text-white outline-none focus:ring-1 focus:ring-info"
              />
              <button
                type="button"
                aria-label={t("Save schedule name")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleSave}
                class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-info transition-colors hover:bg-accent hover:text-white"
              >
                <CheckIcon size={13} />
              </button>
              <button
                type="button"
                aria-label={t("Cancel editing")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCancel}
                class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
              >
                ✕
              </button>
            </div>
          </Show>
          <span class="text-[11px] text-muted-foreground">
            {displayTime(props.schedule.start)} – {displayTime(props.schedule.end)}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <ToggleSwitch
            checked={props.schedule.enabled}
            onChange={() => props.onUpdate(props.schedule.id, { enabled: !props.schedule.enabled })}
            label={t("Toggle {{name}}", { name: displayLabel() })}
          />

          <Show when={props.canDelete}>
            <button
              type="button"
              aria-label={t("Delete {{name}}", { name: displayLabel() })}
              onClick={() => props.onRemove(props.schedule.id)}
              class="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              ✕
            </button>
          </Show>
        </div>
      </div>

      {/* Time Range Selector */}
      <div class="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
        <span class="text-[11px]">{t("Hours:")}</span>
        <input
          type="time"
          value={props.schedule.start}
          aria-label={t("{{name}} start time", { name: displayLabel() })}
          onChange={(e) => props.onUpdate(props.schedule.id, { start: e.currentTarget.value })}
          class="rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-white outline-none focus:border-info"
        />
        <span>{t("to")}</span>
        <input
          type="time"
          value={props.schedule.end}
          aria-label={t("{{name}} end time", { name: displayLabel() })}
          onChange={(e) => props.onUpdate(props.schedule.id, { end: e.currentTarget.value })}
          class="rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-white outline-none focus:border-info"
        />
      </div>

      {/* Day of Week Chips */}
      <div class="flex gap-1">
        <For each={DAYS_OF_WEEK}>
          {({ day, name }) => {
            const isActive = () => props.schedule.days.includes(day);

            return (
              <button
                type="button"
                onClick={() => handleToggleDay(day)}
                aria-pressed={isActive() ? "true" : "false"}
                aria-label={t(
                  name as
                    | "Monday"
                    | "Tuesday"
                    | "Wednesday"
                    | "Thursday"
                    | "Friday"
                    | "Saturday"
                    | "Sunday",
                )}
                class={`flex h-6.5 flex-1 cursor-pointer items-center justify-center rounded-md border text-[11px] font-bold transition-all ${
                  isActive()
                    ? "border-info bg-info text-black"
                    : "border-border bg-accent text-muted-foreground hover:bg-accent"
                }`}
              >
                {weekdayLabel(day)}
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

export function CommuteScheduleTab() {
  const { t } = useI18n();
  const { preferences, updateCommuteSchedule, addCommuteSchedule, removeCommuteSchedule } =
    useUserPreferences();
  const { isAvailable } = usePushAvailability();

  const handleAddWindow = () => {
    const newSchedule: CommuteSchedule = {
      id: `custom_${Date.now()}`,
      label: "Custom Commute",
      labelSource: "default",
      enabled: true,
      days: [1, 2, 3, 4, 5],
      start: "12:00",
      end: "14:00",
    };
    addCommuteSchedule(newSchedule);
  };

  return (
    <Show
      when={isAvailable()}
      fallback={
        <div class="rounded-xl border border-border bg-card p-4 text-center text-xs text-muted-foreground">
          {t(
            "Push notifications are not supported by this browser or server VAPID keys are unconfigured.",
          )}
        </div>
      }
    >
      <div class="flex flex-col gap-3">
        <For each={preferences.commuteSchedules}>
          {(schedule) => (
            <CommuteScheduleCard
              schedule={schedule}
              canDelete={preferences.commuteSchedules.length > 1}
              onUpdate={updateCommuteSchedule}
              onRemove={removeCommuteSchedule}
            />
          )}
        </For>

        {/* Add Custom Window Button */}
        <button
          type="button"
          onClick={handleAddWindow}
          class="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-info/40 bg-card py-2.5 text-xs font-semibold text-info transition-colors hover:border-info hover:bg-accent"
        >
          <span>+</span>
          <span>{t("Add Custom Commute Window")}</span>
        </button>
      </div>
    </Show>
  );
}
