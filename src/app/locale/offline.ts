export const offlineEn = {
  title: "Offline adventures",
  policy: "Offline results and synchronization",
  notFound: "This run is not available for the current account on this device.",
  intro:
    "Download an adventure while connected, then play and save on this device.",
  downloads: "Downloaded adventures",
  available: "Available to download",
  runs: "Runs on this device",
  download: "Download",
  downloading: "Downloading · {{progress}}%",
  ready: "Ready on this device",
  needsSetup:
    "Offline launch is not ready. Wait for app installation to finish, then reload. Your existing local saves are retained.",
  remove: "Remove download",
  start: "Start offline run",
  resume: "Resume offline run",
  onlineOnly: "Online only",
  library: "Return to library",
  empty: "Nothing downloaded yet.",
  checkpoint: "Prepare online checkpoint",
  checkpointNote:
    "This creates a separate offline continuation. Your online session remains intact. If it advances, synchronization will report a conflict.",
  saved: "Saved on this device",
  saving: "Saving on this device…",
  pending: "Pending server validation",
  syncing: "Synchronizing…",
  synced: "Validated by server",
  sync: "Synchronize",
  retry: "Retry",
  guest: "Guest runs stay on this device and cannot be uploaded.",
  eligibility:
    "Offline outcomes are provisional until replayed by the server. Validated offline runs stay in your personal offline archive; they do not award platform stats, account achievements, badges, standings or timing records.",
  export: "Export recovery file",
  delete: "Delete run",
  confirmDelete:
    "Delete this run and its unsynchronized progress? Export a recovery file first if you want to keep it.",
  confirmRemove:
    "Remove this download? Existing runs and their unsynchronized progress will be kept.",
  cancel: "Cancel",
  confirm: "Confirm deletion",
  reload: "Reload saved run",
  complete: "Adventure complete",
  archive: "Your validated offline archive",
  refreshArchive: "Refresh server archive",
  steps: "{{count}} committed actions",
  localOnly: "Retain local run",
  error:
    "Could not complete that action. Your last committed save is retained. Retry or export recovery.",
  errors: {
    action_limit:
      "This run reached the supported action limit. Synchronize or export it before starting another run.",
    storage_failed:
      "Browser storage could not commit the save. Free space and retry. Your previous save is retained.",
    storage_blocked: "Close other Adventures tabs and retry storage access.",
    missing_runtime:
      "The required runtime is missing or damaged. Re-download while connected, or export recovery.",
    unsupported_runtime:
      "This runtime version is not available in this build. Keep or export this run; it will not be reinterpreted.",
    incompatible_bundle:
      "Content or runtime versions do not match. Keep the run and use its compatible build.",
    invalid_checkpoint:
      "This checkpoint cannot be used. Reconnect and prepare it again.",
    incompatible_checkpoint:
      "This online history does not replay under the available content. Keep playing online.",
    invalid_recovery:
      "Recovery data does not match its action history. Export it before making changes.",
    invalid_actions:
      "The action history was rejected. Keep the local run or export recovery.",
    stale_tab:
      "Another tab changed this run. Reload its committed save before continuing.",
    busy_tab: "This run is busy in another tab. Retry after it finishes.",
    locking_unavailable:
      "This browser cannot safely lock offline runs. Use a browser with Web Locks support.",
    member_required:
      "Only runs created for this signed-in account can synchronize. Guest runs remain local.",
    account_changed:
      "The active account changed. Reopen downloads for the current account.",
    lineage_conflict:
      "Server history advanced separately. Both histories are retained. Keep or export this local run; they will not be merged.",
    idempotency_mismatch:
      "This retry differs from the stored request. Keep the run and export recovery.",
    unsupported_campaign: "This adventure needs an online runtime.",
    network_error:
      "The server could not be reached. The exact sync request is saved for retry.",
    forbidden: "This account cannot access that download or run.",
    invalid_response:
      "The server response did not match the replay. Retry the saved request.",
  },
};
export const offlineBg = {
  title: "Приключения без интернет",
  policy: "Резултати без интернет и синхронизация",
  notFound: "Тази игра не е налична за текущия профил на това устройство.",
  intro:
    "Изтегли приключение с интернет, после играй и запазвай на това устройство.",
  downloads: "Изтеглени приключения",
  available: "Налични за изтегляне",
  runs: "Игри на това устройство",
  download: "Изтегли",
  downloading: "Изтегляне · {{progress}}%",
  ready: "Готово на това устройство",
  needsSetup:
    "Стартирането без интернет още не е готово. Изчакай инсталирането на приложението и презареди. Съществуващите локални записи са запазени.",
  remove: "Премахни изтегленото",
  start: "Започни игра без интернет",
  resume: "Продължи играта без интернет",
  onlineOnly: "Само с интернет",
  library: "Към библиотеката",
  empty: "Още няма изтеглени приключения.",
  checkpoint: "Подготви точка за игра без интернет",
  checkpointNote:
    "Създава отделно продължение без интернет. Онлайн сесията се запазва. Ако тя напредне, синхронизацията ще отчете конфликт.",
  saved: "Запазено на това устройство",
  saving: "Запазване на устройството…",
  pending: "Чака проверка от сървъра",
  syncing: "Синхронизиране…",
  synced: "Проверено от сървъра",
  sync: "Синхронизирай",
  retry: "Опитай отново",
  guest: "Игрите като гост остават на това устройство и не се качват.",
  eligibility:
    "Резултатите без интернет са предварителни до проверка чрез повторение от сървъра. Проверените игри остават в личния офлайн архив. Те не носят обща статистика, постижения в профила, значки, места в класацията или рекорди за време.",
  export: "Изнеси файл за възстановяване",
  delete: "Изтрий играта",
  confirmDelete:
    "Да се изтрие ли играта с несинхронизирания напредък? Първо изнеси файл за възстановяване, ако искаш да я запазиш.",
  confirmRemove:
    "Да се премахне ли изтегленото? Съществуващите игри и несинхронизираният им напредък ще се запазят.",
  cancel: "Отказ",
  confirm: "Потвърди изтриването",
  reload: "Зареди запазената игра",
  complete: "Приключението завърши",
  archive: "Твоят проверен офлайн архив",
  refreshArchive: "Обнови архива от сървъра",
  steps: "{{count}} запазени действия",
  localOnly: "Запази локалната игра",
  error:
    "Действието не завърши. Последният запис е запазен. Опитай отново или изнеси файл за възстановяване.",
  errors: {
    action_limit:
      "Играта достигна лимита за действия. Синхронизирай или изнеси я, преди да започнеш друга.",
    storage_failed:
      "Браузърът не запази напредъка. Освободи място и опитай отново. Предишният запис е запазен.",
    storage_blocked: "Затвори другите раздели с Adventures и опитай отново.",
    missing_runtime:
      "Необходимият модул липсва или е повреден. Изтегли го отново с интернет или изнеси файл за възстановяване.",
    unsupported_runtime:
      "Тази версия на модула не е налична. Запази или изнеси играта. Тя няма да се изпълни с друга версия.",
    incompatible_bundle:
      "Версиите на съдържанието или модула не съвпадат. Запази играта и използвай съвместима версия.",
    invalid_checkpoint:
      "Точката за продължаване не е валидна. Свържи се и я подготви отново.",
    incompatible_checkpoint:
      "Тази онлайн история не може да се повтори с наличното съдържание. Продължи с интернет.",
    invalid_recovery:
      "Данните за възстановяване не съвпадат с историята. Изнеси ги, преди да променяш нещо.",
    invalid_actions:
      "Историята на действията е отхвърлена. Запази локалната игра или я изнеси.",
    stale_tab:
      "Друг раздел промени тази игра. Зареди последния запис, преди да продължиш.",
    busy_tab: "Друг раздел използва играта. Опитай след малко.",
    locking_unavailable:
      "Този браузър не поддържа безопасно заключване на играта. Използвай браузър с Web Locks.",
    member_required:
      "Синхронизират се само игри, създадени за текущия профил. Игрите като гост остават локални.",
    account_changed:
      "Профилът се промени. Отвори изтегленото за текущия профил.",
    lineage_conflict:
      "Историята на сървъра е напреднала отделно. И двете истории са запазени. Запази или изнеси локалната игра. Те няма да се слеят.",
    idempotency_mismatch:
      "Повторната заявка се различава от запазената. Запази играта и изнеси файл за възстановяване.",
    unsupported_campaign: "Това приключение изисква интернет.",
    network_error:
      "Няма връзка със сървъра. Точната заявка за синхронизация е запазена за повторение.",
    forbidden: "Този профил няма достъп до изтегленото или играта.",
    invalid_response:
      "Отговорът на сървъра не съвпадна с повторението. Повтори запазената заявка.",
  },
};
