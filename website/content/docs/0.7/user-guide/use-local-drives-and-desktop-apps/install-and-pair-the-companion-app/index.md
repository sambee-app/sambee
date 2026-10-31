+++
title = "Install and Pair the Companion App"
+++

Sambee Companion is a desktop helper app that enables Sambee to connect from the browser to local drives on your computer and to open files in natively installed desktop apps.

You do not need Companion for accessing SMB shares from the browser.

## Install Companion

1. Open **Settings** > **Local Drives** and select **Download for this computer** to download the Companion installer.
1. Run the installer and follow the prompts. Make sure to enable auto-starting Companion.
1. Once the installer is completed, Companion should be running.
1. You can find the Companion icon in the system tray (Linux, Windows) or the menu bar (macOS).

## Pair This Browser With Companion

{{< admonition type="note" title="" >}}
During pairing, Sambee and Companion exchange data that is needed to establish a secure connection. The concept is similar in nature to Bluetooth pairing.
{{< /admonition >}}

Open **Settings** > **Local Drives**. Sambee checks whether it can find the Companion app. You should see a check mark next to **Companion app is running**.

Select **Pair this browser**. Sambee and Companion both display a verification code. Confirm that both codes match, then finish pairing. Sambee should now show a check mark next to **This browser is paired**.

Pairing is scoped to the current browser origin and browser profile, not to the whole computer. If you use Sambee from a different browser, a different browser profile, or a different Sambee site origin, approve that browser separately.

Once this browser is paired with Companion, local drives on your computer appear in Sambee's connection list.
