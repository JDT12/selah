# Troubleshooting

## Selah Desktop

| Problem | What to do |
| --- | --- |
| "Selah couldn't start" | The log is in `%LOCALAPPDATA%\Selah\logs` (`server.log`). Another program on port 47821 is fine: Selah picks the next free one |
| Reminders don't appear | Settings → General → Notifications → **Send a test**. If it's sent but nothing shows: Windows Settings → System → Notifications → Selah on, and Do not disturb off (Mac: System Settings → Notifications → Selah, and Focus off) |
| Read-only on the second PC | The other PC still has your library: close Selah there, or **Take over** |
| Forgot the lock PIN | Quit Selah, delete the `"lock"` entry from `%LOCALAPPDATA%\Selah\app\app-settings.json`, start it again. (The PIN keeps people out; it doesn't encrypt the notes.) |
| Start over | Quit Selah and rename `%LOCALAPPDATA%\Selah`; it starts fresh. Rename it back to return |

## Selah Cloud

```bash
cd ~/selah
npm run admin -- status
journalctl --user -u selah-admin -n 100
journalctl --user -u selah-gateway -n 100
docker logs --tail 100 selah-tenant-<name>
```

These show what's running (with the certificate and each Selah), then the admin console's, the gateway's and one
Selah's log.

| Problem | What to do |
| --- | --- |
| A browser says the certificate isn't valid | See [DNS and HTTPS](dns-https.md#checking) |
| "The admin console doesn't answer from this address" | Your address changed: `npm run admin -- allow-ip add <address>` |
| Lost the console's two-step phone | `npm run admin -- reset-two-step`, then sign in and set it up again |
| Someone forgot their password | Console → Tenants → **Setup link**: they choose a new password |
| A Selah shows "Paused" | Console → Tenants → **Resume** |
| Nothing answers after a reboot | `systemctl --user status selah-admin selah-gateway`. Linger must be on: `loginctl show-user $USER -p Linger` |

### Server maintenance

Once a month or so, from `~/selah`:

```bash
npm run admin -- maintenance-stop
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

Then sign in again and run `cd ~/selah && npm run admin -- maintenance-start`. To warn people ahead of time, set a
notice on the console's **Overview** page (the user notice card) first.

## Asking for help

Open an issue on [GitHub](https://github.com/JDT12/selah/issues) with what you did, what happened, and the relevant
lines of the logs above (leave out names, addresses and anything private).
