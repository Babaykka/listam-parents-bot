# Production server

The bot runs as a native systemd service behind the existing nginx TLS host.
It binds to `127.0.0.1:10000`; only nginx exposes the public Mini App and
Telegram webhook. PostgreSQL also listens on localhost only.

## Public ports

- `22/tcp`: SSH;
- `25/tcp`: inbound List.am notifications only;
- `80/tcp`, `443/tcp`: nginx.

All other inbound traffic is denied by UFW. Postfix is configured as an
inbound-only server, accepts only the virtual recipient
`listam-alerts@fizteh-reshit.online`, and rejects relaying to external domains.
OpenDKIM verifies the original signature after Gmail forwarding. The
application accepts a message only when the parsed sender is `post@list.am`
and the trusted server-side authentication result reports `dkim=pass` for
`list.am`.

## List.am email path

1. List.am sends a saved-search notification to the server address.
2. Postfix resolves the virtual address to the locked `listam-bot` system user.
3. `.forward` invokes `scripts/listam_mail_drop.js`, which writes one private,
   atomic EML file under `/var/lib/listam-bot/mail-spool/incoming`.
4. The application reads the spool every 15 seconds, validates the sender and
   DKIM result, parses deterministic listing fields, deduplicates them, updates
   the catalog, and notifies matching subscribers. List.am digest thumbnails
   are retained as partial cards when the email does not include price or area;
   missing values are never invented.
5. Processed and rejected mail is retained privately for 14 days and then
   pruned automatically.

Raw mail, addresses, tokens, and spool paths are never returned by public
health endpoints or Telegram status messages.

## Operations

```bash
sudo systemctl status listam-bot postfix --no-pager
sudo systemctl status opendkim listam-bot-healthcheck.timer --no-pager
sudo journalctl -u listam-bot -u postfix -n 100 --no-pager
sudo postqueue -p
sudo ufw status verbose
curl --fail https://fizteh-reshit.online/health
```

The health timer checks the loopback endpoint every two minutes and restarts a
hung service. A daily state backup is retained for 14 days.

The old macOS relay is intentionally disabled. Production operation must not
open a browser or require the user's laptop.
