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

## Pair Sambee With Companion

{{< admonition type="note" title="" >}}
During pairing, Sambee and Companion exchange data that is needed to establish a secure connection. The concept is similar in nature to Bluetooth pairing.
{{< /admonition >}}

Open **Settings** > **Local Drives**. Sambee checks whether it can find the Companion app. You should see a check mark next to **Companion app is running**.

Select **Pair this browser**. Sambee starts a pairing request for the exact site you are currently using, and Companion opens a native approval window that shows both:

- the requesting browser origin
- a short verification code

Sambee shows the same verification code in the browser. Confirm the pairing only when both codes match and the origin shown in Companion is the Sambee site you expect.

After you approve the request in Companion and confirm it in the browser, Sambee should show a check mark next to **This browser is paired**.

Once Sambee is paired with Companion, local drives on your computer appear in Sambee's connection list.

## What to Expect Later

Pairing is specific to the current browser origin.

- If you use Sambee from a different site or port, that browser origin may need its own pairing.
- If you close the pairing dialog before finishing, the request is cancelled instead of staying pending silently.
- If Sambee later reports that the browser needs repair, start pairing again from **Settings** > **Local Drives** to restore the browser-side secret.
