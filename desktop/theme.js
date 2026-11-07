/**
 * Applies the saved theme before the stylesheet is parsed, so the first paint
 * is already in the right palette instead of flashing light then switching.
 *
 * The preference is a renderer setting (`lane.themeMode`): "light", "dark" or
 * "system". This file runs as a classic script in <head>, before styles.css;
 * the settings page changes the attribute later through app.js.
 */
(function () {
  var modes = ["light", "dark", "system"];
  var mode = "system";
  try {
    var saved = localStorage.getItem("lane.themeMode");
    if (modes.indexOf(saved) >= 0) mode = saved;
  } catch (error) {}
  var dark = mode === "dark" ||
    (mode === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeMode = mode;
})();
