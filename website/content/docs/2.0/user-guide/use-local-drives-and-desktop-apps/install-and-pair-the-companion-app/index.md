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

Open Sambee over HTTPS before pairing from another computer or a network address. Browsers don't provide the cryptographic APIs needed by Companion on ordinary HTTP sites. Local development on `http://localhost` is an exception. If **Local Drives** warns that a secure browser context with Web Crypto support is unavailable, use HTTPS; if you're already using HTTPS, check that your browser supports and permits Web Crypto. You don't need HTTPS to download the Companion installer.

{{< admonition type="note" title="" >}}
During pairing, Sambee and Companion exchange data that is needed to establish a secure connection. The concept is similar in nature to Bluetooth pairing.
{{< /admonition >}}

Open **Settings** > **Local Drives**. Sambee checks whether it can find the Companion app. You should see a check mark next to **Companion app is running**.

Select **Pair this browser**. Sambee starts a pairing request for the exact site you are currently using, and Companion opens a native approval window that shows both:

- the requesting browser origin
- a short verification code

Sambee shows the same verification code in the browser. Confirm the pairing only when both codes match and the origin shown in Companion is the Sambee site you expect.

After you approve the request in Companion and confirm it in the browser, Sambee verifies local access and shows a check mark next to **This browser is paired**.

Once Sambee is paired with Companion, local drives on your computer appear in Sambee's connection list.

## What to Expect Later

Pairing is specific to the current browser origin.

- If you use Sambee from a different site or port, that browser origin may need its own pairing.
- If you close the pairing dialog before finishing, the request is cancelled instead of staying pending silently.

## Restore Local-Drive Access

If a local drive reports a pairing error, open **Settings** > **Local Drives** from the file-list alert. **Ready** means the browser has passed an authenticated pairing check; having a stored pairing alone is not enough.

1. If Companion needs an update, install the available version, restart Companion, and reload the Sambee page. Re-pairing will not resolve an incompatible version.
1. If Sambee needs an update, reload the page. If the version mismatch remains, update Sambee. Updating Companion or re-pairing will not fix a newer Companion protocol.
1. If the file-list alert says this browser isn't paired, open **Local Drives** and select **Pair This Browser**. Reloading alone won't restore a missing or removed pairing.
1. If Companion rejects the browser's signature, reload the Sambee page first. A page left open across an update may still use the previous authentication protocol.
1. Run **Test Current Pairing**. If it still fails with a signature error after reloading, use **Pair This Browser** and approve the new code in Companion.

If Sambee cannot check the pairing status, select **Retry**. Wait for a confirmed status before starting a new pairing. Companion pairing secrets do not expire on a 30-day timer. An unavailable Companion or a temporary failed check does not mean you need to re-pair.
