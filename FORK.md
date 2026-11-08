> If you read this you surely came from [Terra](https://terra.hackclub.com). (If not, check it out)

This is my fork of [jeremy46231/taut](https://github.com/jeremy46231/taut).

Maybe you use Taut or Slick.  
If you don't, you need to try them!  
But in short, they modify Slack and add some new cool features.

I added some plugins and created PRs to [jeremy46231/taut](https://github.com/jeremy46231/taut), but they are still pending.

Plugins I added:

1. [App Home Gate](plugins/AppHomeGate.tsx) [[PR](https://github.com/jeremy46231/taut/pull/37)]
2. [Installed Apps](plugins/InstalledApps.tsx) [[PR](https://github.com/jeremy46231/taut/pull/33)] (already in [Slick](https://github.com/3kh0/slick/pull/373))
3. [Hackatime Stats](plugins/HackatimeStats.tsx) [[PR](https://github.com/jeremy46231/taut/pull/34)]
4. [User Memberships](plugins/UserMemberships.tsx) [[PR](https://github.com/jeremy46231/taut/pull/40)]

Want to try them yourself? Read [this](#i-want-them)

Read the PRs to see what the plugins do.

## I want them!

Good, it simple, you need Taut, download it from [here](https://github.com/jeremy46231/taut),
while you could also download it from my release page (if you are wondering [here](https://github.com/Fantamomo/taut/releases/tag/latest))
i dont recommend it because [@jeremy46231](https://github.com/jeremy46231) signed the builds so you dont get the virus warnings.

After successfully downloaded it and logging in, check what you donwloaded and follow the steps for each platform:

* **Desktop**: Click in the menu bar on the `Taut` button and select `Change App Source`.
* **Userscript**: Tampermonkey icon while on Slack then `Options` or [taut.jer.app/options](https://taut.jer.app/options)
* **Extension**: Manage extensions and then Taut, and then something like `Options`/`Config` or if available press the Taut icon next to the search bar and then `Options`/`Config`

In the now opened window paste the following URL:

```
https://github.com/Fantamomo/taut/releases/download/latest/taut.js
```

After that press `Save` and restart Taut, or press `STRG+SHIFT+R`/`CMD+SHIFT+R` to force reload it.

After that you only need to enable the plugins in the `Preferences` menu. Open it. Select `Taut`.  
And search for the plugins and enable them.

The easiest way to check if they works, is to any user profile and scroll down to the bottom of the page. You should see all installed apps, the Hackatime stats, the user memberships.

Now you can enjoy them! (Please leave feedback)
