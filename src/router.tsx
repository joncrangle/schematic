import { createRouter } from "@solidjs/router";
import Home from "~/routes/index";
import { useI18n } from "~/i18n/I18nContext";

function NotFound() {
  const { t } = useI18n();
  return (
    <main class="flex h-dvh w-full flex-col items-center justify-center gap-2 bg-background font-sans">
      <div class="text-lg font-bold text-foreground">{t("Not found")}</div>
      <div class="text-sm text-muted-foreground">{t("This page does not exist.")}</div>
      <a href="/" class="mt-2 rounded-full border border-border px-4 py-2 text-sm text-foreground">
        {t("Back to map")}
      </a>
    </main>
  );
}

export const Router = createRouter({
  routes: [
    {
      path: "/",
      component: Home,
    },
    {
      path: "*404",
      component: NotFound,
    },
  ],
});

export const { paths } = Router;
