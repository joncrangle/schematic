import { createSignal, For, onSettled, Show } from "solid-js";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useI18n } from "~/i18n/I18nContext";
import type { TranslationKey } from "~/i18n/en";
import type { PlainTranslationKey } from "~/i18n/translate";
import { RegionalPreferences } from "./RegionalPreferences";
import { useMobileViewport } from "~/hooks/useMobileViewport";
import { resolveInterchangeBadgeVisibility } from "~/domain/map/InterchangeBadgeVisibility";
import type { InterchangeBadgeVisibility } from "~/domain/preferences/UserPreferences";
import { ToggleSwitch } from "./ToggleSwitch";
import { OpenDataAttribution } from "~/components/legal/OpenDataAttribution";
import { usePushAvailability } from "~/hooks/usePushAvailability";
import {
  isPushSupported,
  getPushPermission,
  isPushSubscribed,
  subscribeToPush,
  unsubscribeFromPush,
  type PushPermissionState,
} from "~/services/notifications/PushNotificationService";
import {
  triggerTestPush,
  type TriggerTestPushResult,
} from "~/services/notifications/NotificationClient";

type TestPushFeedback =
  | { readonly tone: "ok"; readonly sent: number; readonly expiredSubscriptionsPruned: number }
  | {
      readonly tone: "error";
      readonly message: string;
      readonly translationKey?: PlainTranslationKey;
    };

const BUILT_IN_PUSH_ERROR_KEYS = [
  "Push notifications are not supported by this browser.",
  "Push notifications are not supported.",
  "Notification permission was not granted by your browser.",
  "Unable to contact server for push notification keys.",
  "Server push notifications are not configured (missing VAPID keys in server environment).",
  "Service Worker is not active or failed to register in your browser.",
  "Invalid VAPID public key received from server.",
  "Failed to save push subscription on the server.",
  "Browser generated invalid push subscription credentials.",
] as const satisfies readonly TranslationKey[];

const TEST_PUSH_ERROR_KEYS = [
  "Test notification failed.",
  "No active subscription received the test. Enable push notifications first.",
  "Failed to trigger test notification.",
] as const satisfies readonly TranslationKey[];

const interchangeBadgeVisibilityOptions: readonly {
  readonly value: InterchangeBadgeVisibility;
  readonly label: string;
}[] = [
  { value: "full", label: "Full" },
  { value: "compact", label: "Compact" },
  { value: "hidden", label: "Hidden" },
];

export interface PreferencesTabProps {
  readonly agencyId?: string;
}

export function PreferencesTab(props: PreferencesTabProps = {}) {
  const { preferences, setReducedMotion, setShowReducedSpeedZones, setInterchangeBadgeVisibility } =
    useUserPreferences();
  const i18n = useI18n();
  const t = i18n.t;
  const { isAvailable } = usePushAvailability();
  const isMobileViewport = useMobileViewport();

  const pushFailureKey = (
    reason:
      | "unsupported"
      | "permission_denied"
      | "vapid_unconfigured"
      | "subscription_failed"
      | "network_error"
      | "unknown"
      | undefined,
    action: "enable" | "disable",
  ): PlainTranslationKey => {
    if (reason === "permission_denied")
      return "Notification permission was not granted by your browser.";
    if (reason === "vapid_unconfigured") return "Server push notifications are not configured.";
    if (reason === "subscription_failed") return "Push subscription could not be created.";
    if (reason === "network_error") return "Unable to connect to push notification service.";
    if (reason === "unsupported") return "Push notifications are not supported by this browser.";
    return action === "disable"
      ? "Failed to unsubscribe from push notifications."
      : "Failed to enable push notifications.";
  };

  const presentPushError = (message: string | undefined, fallback: PlainTranslationKey): string => {
    if (!message) return t(fallback);
    const key = BUILT_IN_PUSH_ERROR_KEYS.find((candidate) => candidate === message);
    return key ? t(key) : message;
  };

  const [isSubscribed, setIsSubscribed] = createSignal(false);
  const [permission, setPermission] = createSignal<PushPermissionState>("unsupported");
  const [isPushLoading, setIsPushLoading] = createSignal(false);
  const [pushErrorMessage, setPushErrorMessage] = createSignal<{
    readonly message: string | undefined;
    readonly fallback: PlainTranslationKey;
  } | null>(null);

  // Dev-only test push trigger
  const [testPushTitle, setTestPushTitle] = createSignal("");
  const [testPushBody, setTestPushBody] = createSignal("");
  const [isSendingTestPush, setIsSendingTestPush] = createSignal(false);
  const [testPushFeedback, setTestPushFeedback] = createSignal<TestPushFeedback | null>(null);

  const refreshPushStatus = async () => {
    if (!isPushSupported()) {
      setPermission("unsupported");
      setIsSubscribed(false);
      return;
    }
    setPermission(getPushPermission());
    const subscribed = await isPushSubscribed();
    setIsSubscribed(subscribed);
  };

  onSettled(() => {
    refreshPushStatus();
  });

  const selectedInterchangeBadgeVisibility = () =>
    resolveInterchangeBadgeVisibility(preferences.interchangeBadgeVisibility, isMobileViewport());

  const handleTogglePush = async () => {
    if (isPushLoading() || !isPushSupported()) return;

    setPushErrorMessage(null);
    setIsPushLoading(true);
    try {
      if (isSubscribed()) {
        const result = await unsubscribeFromPush();
        if (!result.success) {
          setPushErrorMessage({
            message: result.message,
            fallback: pushFailureKey(result.reason, "disable"),
          });
        }
      } else {
        const result = await subscribeToPush(preferences);
        if (!result.success) {
          setPushErrorMessage({
            message: result.message,
            fallback: pushFailureKey(result.reason, "enable"),
          });
        }
      }
    } finally {
      await refreshPushStatus();
      setIsPushLoading(false);
    }
  };

  const handleSendTestPush = async () => {
    if (isSendingTestPush()) return;

    setTestPushFeedback(null);
    setIsSendingTestPush(true);
    try {
      const title = testPushTitle().trim();
      const body = testPushBody().trim();
      const result: TriggerTestPushResult = await triggerTestPush({
        title: title || undefined,
        body: body || undefined,
      });

      if (!result.ok) {
        const message = result.message || "Test notification failed.";
        const translationKey = TEST_PUSH_ERROR_KEYS.find((candidate) => candidate === message);
        setTestPushFeedback({ tone: "error", message, translationKey });
      } else if (result.sent > 0) {
        setTestPushFeedback({
          tone: "ok",
          sent: result.sent,
          expiredSubscriptionsPruned: result.expiredSubscriptionsPruned,
        });
      } else {
        setTestPushFeedback({
          tone: "error",
          message: "No active subscription received the test. Enable push notifications first.",
          translationKey:
            "No active subscription received the test. Enable push notifications first.",
        });
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Failed to trigger test notification.";
      const translationKey = TEST_PUSH_ERROR_KEYS.find((candidate) => candidate === message);
      setTestPushFeedback({ tone: "error", message, translationKey });
    } finally {
      setIsSendingTestPush(false);
    }
  };

  const testPushFeedbackText = (feedback: TestPushFeedback): string => {
    if (feedback.tone === "error")
      return feedback.translationKey ? t(feedback.translationKey) : feedback.message;
    const staleNote =
      feedback.expiredSubscriptionsPruned > 0
        ? i18n.plural("Stale subscription removal", feedback.expiredSubscriptionsPruned)
        : "";
    return t("Test push result", {
      count: feedback.sent,
      staleNote,
    });
  };

  return (
    <div class="flex flex-col gap-2.5">
      <RegionalPreferences />

      {/* Motion & Display Card */}
      <div class="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
        {/* Reduce Motion */}
        <div class="flex items-center justify-between gap-3">
          <label for="reduce-motion-toggle" class="flex cursor-pointer flex-col">
            <span class="text-[13px] font-semibold text-white">{t("Reduce Motion")}</span>
            <span class="text-[11px] text-muted-foreground">
              {t("Disables pulse auras on network map")}
            </span>
          </label>
          <ToggleSwitch
            id="reduce-motion-toggle"
            checked={preferences.reducedMotion === "reduce"}
            onChange={() =>
              setReducedMotion(preferences.reducedMotion === "reduce" ? "system" : "reduce")
            }
            label={t("Reduce motion toggle")}
          />
        </div>

        <div class="h-px bg-accent" />

        {/* RSZ Toggle */}
        <div class="flex items-center justify-between gap-3">
          <label for="reduced-speed-zones-toggle" class="flex cursor-pointer flex-col">
            <span class="text-[13px] font-semibold text-white">{t("Reduced Speed Zones")}</span>
            <span class="text-[11px] text-muted-foreground">
              {t("Show amber tracks for slow zones")}
            </span>
          </label>
          <ToggleSwitch
            id="reduced-speed-zones-toggle"
            checked={preferences.showReducedSpeedZones}
            onChange={() => setShowReducedSpeedZones(!preferences.showReducedSpeedZones)}
            label={t("Reduced speed zones toggle")}
          />
        </div>

        <div class="h-px bg-accent" />

        {/* Interchange Badge Visibility */}
        <fieldset class="flex flex-col gap-2">
          <legend class="text-[13px] font-semibold text-white">
            {t("Interchange Agency Badges")}
          </legend>
          <span
            id="interchange-badge-visibility-description"
            class="text-[11px] text-muted-foreground"
          >
            {t("Compact is the mobile default; full is the desktop default")}
          </span>
          <div class="grid grid-cols-3 rounded-lg border border-border bg-background p-0.5">
            <For each={interchangeBadgeVisibilityOptions}>
              {(option) => (
                <label class="cursor-pointer">
                  <input
                    type="radio"
                    name="interchange-badge-visibility"
                    value={option.value}
                    checked={selectedInterchangeBadgeVisibility() === option.value}
                    aria-describedby="interchange-badge-visibility-description"
                    onChange={() => setInterchangeBadgeVisibility(option.value)}
                    class="peer sr-only"
                  />
                  <span class="block rounded-md px-2 py-1.5 text-center text-[11px] font-semibold text-muted-foreground transition-colors peer-checked:bg-accent peer-checked:text-white peer-checked:shadow-xs peer-focus-visible:ring-2 peer-focus-visible:ring-info">
                    {t(option.label as "Full" | "Compact" | "Hidden")}
                  </span>
                </label>
              )}
            </For>
          </div>
        </fieldset>
      </div>

      {/* Web Push Notifications (Visible only when browser supports push AND server VAPID keys are configured) */}
      <Show when={isAvailable()}>
        <div class="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
          <div class="flex items-center justify-between gap-3">
            <label for="push-notifications-toggle" class="flex cursor-pointer flex-col">
              <span class="text-[13px] font-semibold text-white">
                {t("Commute Push Notifications")}
              </span>
              <span class="text-[11px] text-muted-foreground">
                {isSubscribed()
                  ? t("Active during your commute windows for severe alerts")
                  : permission() === "denied"
                    ? t("Notifications blocked in browser permissions")
                    : t("Receive alerts for favourite transit during commute hours")}
              </span>
            </label>
            <ToggleSwitch
              id="push-notifications-toggle"
              checked={isSubscribed()}
              disabled={isPushLoading() || permission() === "denied"}
              onChange={handleTogglePush}
              label={t("Push notifications toggle")}
            />
          </div>

          {/* Error notification banner */}
          <Show when={pushErrorMessage()}>
            {(msg) => (
              <div class="flex items-start justify-between gap-2 rounded-lg border border-destructive-300/30 bg-destructive-300/10 p-2.5 text-[11px] text-destructive-300">
                <div class="flex items-start gap-1.5">
                  <span class="text-sm leading-none">⚠️</span>
                  <span>{presentPushError(msg().message, msg().fallback)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPushErrorMessage(null)}
                  class="text-muted-foreground hover:text-white transition-colors cursor-pointer"
                  aria-label={t("Dismiss error message")}
                >
                  ✕
                </button>
              </div>
            )}
          </Show>
        </div>

        {/* Web Push Callout Banner */}
        <div class="rounded-lg border-l-2 border-info bg-card p-2.5 text-[11px] text-muted-foreground leading-relaxed">
          🔔 <strong class="text-foreground">{t("System Web Push:")}</strong>{" "}
          {t(
            "Notifications are delivered directly by your browser only during active commute windows for severe network disruptions.",
          )}
        </div>
      </Show>

      {/* Dev-only: manual test push trigger (server fn hard-rejects in production).
          Rendered outside the VAPID-availability gate so the server's
          "keys not configured" diagnostic stays reachable in dev. */}
      <Show when={import.meta.env.DEV}>
        <div class="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
          <span class="text-[11px] font-semibold text-muted-foreground">{t("Dev test push")}</span>
          <label for="dev-test-push-title" class="text-[11px] text-muted-foreground">
            {t("Title")}
          </label>
          <input
            id="dev-test-push-title"
            type="text"
            placeholder={t("Custom title (optional)")}
            value={testPushTitle()}
            onInput={(e) => setTestPushTitle(e.currentTarget.value)}
            class="min-w-0 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:border-info focus:outline-none"
          />
          <label for="dev-test-push-body" class="text-[11px] text-muted-foreground">
            {t("Body")}
          </label>
          <input
            id="dev-test-push-body"
            type="text"
            placeholder={t("Custom message (optional)")}
            value={testPushBody()}
            onInput={(e) => setTestPushBody(e.currentTarget.value)}
            class="min-w-0 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:border-info focus:outline-none"
          />
          <button
            type="button"
            onClick={handleSendTestPush}
            disabled={isSendingTestPush()}
            class="cursor-pointer self-start rounded-lg border border-info/40 bg-info/10 px-2.5 py-1.5 text-[12px] font-semibold text-info transition-colors hover:bg-info/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSendingTestPush() ? t("Sending…") : t("Send test notification")}
          </button>
          <Show when={testPushFeedback()}>
            {(feedback) => (
              <span
                class={`text-[11px] leading-relaxed ${
                  feedback().tone === "ok" ? "text-live-400" : "text-destructive-300"
                }`}
              >
                {testPushFeedbackText(feedback())}
              </span>
            )}
          </Show>
        </div>
      </Show>

      {/* Open Data & Legal Attribution */}
      <OpenDataAttribution agencyId={props.agencyId} />
    </div>
  );
}
