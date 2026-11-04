// welcome.html, the setup page of earlier versions: install's pairing link (welcome.html#code=…) and old bookmarks
// still open it, so it forwards to onboarding.html with the query and fragment intact.
location.replace(`onboarding.html${location.search}${location.hash}`)
