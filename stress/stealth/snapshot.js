// Navigator and locale values, run identically in the window and in dedicated, shared and service workers by the
// stealth probe (probe.html). A real browser reports the same values everywhere; spoofing usually misses a scope.
self.__probeSnapshot = async function () {
  const nav = self.navigator
  let highEntropy = null
  try {
    highEntropy = nav.userAgentData
      ? await nav.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList", "uaFullVersion"])
      : null
  } catch (error) {
    highEntropy = { error: String(error) }
  }
  return {
    userAgent: nav.userAgent,
    uaBrands: nav.userAgentData ? nav.userAgentData.brands.map((brand) => `${brand.brand}/${brand.version}`).join(", ") : null,
    uaPlatform: nav.userAgentData ? nav.userAgentData.platform : null,
    uaMobile: nav.userAgentData ? nav.userAgentData.mobile : null,
    highEntropy,
    platform: nav.platform,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    languages: nav.languages ? Array.from(nav.languages).join(",") : null,
    language: nav.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    webdriver: nav.webdriver ?? null,
  }
}
