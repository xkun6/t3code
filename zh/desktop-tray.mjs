// Windows only: closing the main window hides it to a tray icon so the backend and running agents
// keep going. Quitting goes through the tray menu or any app.quit() (Ctrl+Q, updater, shutdown).
// vite-plugin.cjs appends the Electron and i18n wiring, so tests can load this file without them.

export function createZhTray({ app, Menu, Tray, labels, onLocaleChange, platform = process.platform }) {
  if (platform !== "win32") return () => {};
  let quitting = false;
  let current = null;
  let tray = null;
  let creating = null;
  const markQuitting = () => {
    quitting = true;
  };
  app.on("before-quit", markQuitting);

  const show = () => {
    if (!current || current.isDestroyed()) return;
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
  };

  const buildMenu = () => {
    const { show: showLabel, quit } = labels();
    tray.setToolTip(app.getName());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: showLabel, click: show },
        { type: "separator" },
        { label: quit, click: () => app.quit() },
      ]),
    );
  };

  const createTray = async (iconPath) => {
    // Same icon.ico as the main window; the exe's icon only if the window had none.
    const icon = iconPath ?? (await app.getFileIcon(process.execPath, { size: "normal" }));
    if (quitting) return;
    tray = new Tray(icon);
    buildMenu();
    tray.on("click", show);
    // Same trigger the application menu rebuilds on.
    onLocaleChange(buildMenu);
  };

  return (window, iconPath) => {
    current = window;
    creating ??= createTray(iconPath).catch((error) => console.warn("[t3code-zh] tray unavailable", error));
    // Windows logoff/shutdown must not be blocked by a hidden window.
    window.on("query-session-end", markQuitting);
    window.on("session-end", markQuitting);
    window.on("close", (event) => {
      // Without a tray icon a hidden window could not be brought back.
      if (quitting || !tray) return;
      event.preventDefault();
      window.hide();
    });
  };
}
