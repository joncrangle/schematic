import type { WorkerMessages } from "../localeWorkerMessage";

export const frWorkerMessages = {
  offlineDocumentTitle: "Hors ligne",
  offlineHeading: "Impossible de récupérer l’état du transport en direct",
  offlineMessage:
    "Vous êtes hors ligne. Vérifiez votre connexion Internet pour recevoir les mises à jour du transport en temps réel.",
  offlineApiError: "Hors ligne",
  offlineApiMessage: "Impossible de récupérer l’état du transport en direct hors ligne.",
  genericPushTitle: "🚨 Perturbation du service de transport",
  genericPushBody: "Une perturbation majeure affecte votre trajet.",
} satisfies WorkerMessages;
