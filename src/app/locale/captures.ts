export const capturesEn = {
  eyebrow: "SUBZERO STORY SYSTEM // PROBLEM REPORTS",
  title: "Problem reports",
  intro:
    "A problem report is a copy of one session's full history, including the seed that decided every random draw, so the problem can be replayed exactly. Each one is kept for 30 days and then deleted.",
  unavailable: "Problem reports aren't available on this build.",
  loading: "Loading your record…",
  anonymous: "Play a story or sign in first -- there's nothing on record yet.",
  report: {
    open: "Report a problem",
    title: "Report a problem with this session",
    consent:
      "I agree to send this session's full history, including its random seed, to the Adventures team. It is kept for 30 days and then deleted.",
    submit: "Send report",
    sending: "Sending…",
    cancel: "Cancel",
    sent: "Report sent. You can download or delete it from",
    sentLink: "your problem reports",
    offline: "Reconnect to send a report.",
  },
  fault: {
    title: "Automatic reports",
    body: "When a session hits an internal error, save a problem report automatically. It holds the same data as a report you send yourself and is kept for 30 days. Off unless you turn it on.",
    label: "Save a report automatically when a session fails",
    consentedAt: "Turned on {{date}}.",
    off: "Off.",
    saving: "Saving…",
  },
  list: {
    title: "Your reports",
    created: "Reported",
    expires: "Deleted on",
    campaign: "Adventure",
    session: "Session",
    trigger: "Trigger",
    actions: "Actions",
    download: "Download",
    downloading: "Downloading…",
    delete: "Delete",
    deleting: "Deleting…",
    deleteAll: "Delete all reports",
    deletingAll: "Deleting…",
    empty: "No problem reports.",
  },
  triggers: {
    report: "Reported",
    fault: "Automatic",
  },
  admin: {
    title: "Session captures",
    note: "Every unexpired capture, from a player's report or an automatic fault capture. A download holds the session's full history and seed: keep it out of public issues.",
    player: "Player",
    capture: "Capture",
    sessionId: "Session id",
    consent:
      "The session's owner reported this problem and agreed to a capture.",
    submit: "Capture session",
    capturing: "Capturing…",
    captured: "Captured {{id}}.",
  },
  errors: {
    consent_required: "Tick the box to agree before sending a report.",
    forbidden: "This session is not yours to report.",
    campaign_access_revoked:
      "You no longer have access to this adventure, so its session can't be reported.",
    unknown_session: "This session could not be found.",
    unknown_campaign: "This session's adventure is no longer available.",
    unknown_capture: "This report could not be found. It may have expired.",
    invalid_state: "This session can't be captured in its current state.",
    campaign_deleted:
      "This adventure has been deleted, so its session can't be reported.",
    storage_failure:
      "The report could not be saved right now. Try again shortly.",
    generic: "The report could not be sent. Try again.",
  },
};

export const capturesBg: typeof capturesEn = {
  eyebrow: "SUBZERO STORY SYSTEM // ДОКЛАДИ ЗА ПРОБЛЕМИ",
  title: "Доклади за проблеми",
  intro:
    "Докладът за проблем е копие на цялата история на една игра, включително началната стойност, която е решила всеки случаен избор, за да може проблемът да се възпроизведе точно. Всеки доклад се пази 30 дни и след това се изтрива.",
  unavailable: "Докладите за проблеми не са налични в тази версия.",
  loading: "Зареждане на данните ти…",
  anonymous:
    "Първо изиграй история или влез в профила си -- все още няма нищо записано.",
  report: {
    open: "Докладвай проблем",
    title: "Докладвай проблем с тази игра",
    consent:
      "Съгласен съм да изпратя цялата история на тази игра, включително случайната ѝ начална стойност, на екипа на Adventures. Тя се пази 30 дни и след това се изтрива.",
    submit: "Изпрати доклада",
    sending: "Изпращане…",
    cancel: "Отказ",
    sent: "Докладът е изпратен. Можеш да го изтеглиш или изтриеш от",
    sentLink: "твоите доклади",
    offline: "Свържи се, за да изпратиш доклад.",
  },
  fault: {
    title: "Автоматични доклади",
    body: "Когато в игра възникне вътрешна грешка, запазвай доклад автоматично. Той съдържа същите данни като доклад, изпратен от теб, и се пази 30 дни. Изключено, докато не го включиш.",
    label: "Запазвай доклад автоматично, когато игра се провали",
    consentedAt: "Включено на {{date}}.",
    off: "Изключено.",
    saving: "Запазване…",
  },
  list: {
    title: "Твоите доклади",
    created: "Докладван",
    expires: "Изтрива се на",
    campaign: "Приключение",
    session: "Игра",
    trigger: "Повод",
    actions: "Действия",
    download: "Изтегли",
    downloading: "Изтегляне…",
    delete: "Изтрий",
    deleting: "Изтриване…",
    deleteAll: "Изтрий всички доклади",
    deletingAll: "Изтриване…",
    empty: "Няма доклади за проблеми.",
  },
  triggers: {
    report: "Докладван",
    fault: "Автоматичен",
  },
  admin: {
    title: "Записи на игри",
    note: "Всички неизтекли записи – от доклад на играч или автоматичен запис при грешка. Изтегленият файл съдържа цялата история и началната стойност на играта: не го публикувай в публични задачи.",
    player: "Играч",
    capture: "Запис",
    sessionId: "Идентификатор на играта",
    consent:
      "Собственикът на играта е докладвал проблема и е съгласен със записа.",
    submit: "Запиши играта",
    capturing: "Записване…",
    captured: "Записано: {{id}}.",
  },
  errors: {
    consent_required: "Отметни полето за съгласие, преди да изпратиш доклад.",
    forbidden: "Тази игра не е твоя и не можеш да я докладваш.",
    campaign_access_revoked:
      "Вече нямаш достъп до това приключение, затова играта не може да бъде докладвана.",
    unknown_session: "Тази игра не беше намерена.",
    unknown_campaign: "Приключението на тази игра вече не е налично.",
    unknown_capture: "Този доклад не беше намерен. Може да е изтекъл.",
    invalid_state: "Тази игра не може да бъде записана в текущото ѝ състояние.",
    campaign_deleted:
      "Това приключение е изтрито, затова играта не може да бъде докладвана.",
    storage_failure:
      "Докладът не можа да бъде запазен в момента. Опитай отново след малко.",
    generic: "Докладът не можа да бъде изпратен. Опитай отново.",
  },
};
