# Market order confirmation regression tests

Market previews are tied to a unique draft ID, private chat, and connected
session. Only the latest preview can be confirmed. Reconnecting or disconnecting
invalidates previews and confirmations still checking account permissions or
waiting for the fill stream. Confirmation IDs contain no session credentials.

Real market orders wait up to five seconds for the private stream's subscription
frame to be sent. If account permission checks or stream preparation fail, no
order is submitted. The stream stays active across idle/position reconciliation
until the user disconnects or the runtime explicitly stops.

An order acknowledgement is not proof of a fill. A timeout after submission is
ambiguous: check authoritative exchange order state before creating another
order. The same confirmation cannot automatically resubmit.

## Automated checks

Run `npm run verify`. The market-order, account-stream and runtime tests cover
old confirmation/cancel buttons, duplicate clicks, session changes during account
refresh and stream preparation, subscription failures/timeouts, and immediate
and later fills without active triggers. HTTP and sockets are mocked.

## Manual checks

Use paper mode for confirmation/cancellation checks. Use a dedicated testnet
account and valid testnet quantity for actual fill checks.

1. Create a BTC preview, then an ETH preview. Click Submit on the older BTC
   message. Expect an expired-confirmation error and no submission. Confirm the
   ETH preview; expect exactly the ETH side/quantity shown in that preview.
2. Repeat with Cancel on the old preview. Expect an expired-confirmation error;
   the current preview must still work. Cancel the current preview and verify
   that its Submit button can no longer submit.
3. Create a preview, disconnect/reconnect or change accounts, then click its
   Submit button. Expect no order. The automated delayed-request tests also
   cover changing accounts while confirmation is already waiting.
4. Confirm the same preview twice. Expect only one submission. Also test a
   preview older than five minutes; it must not submit.
5. On testnet, connect a user with no active triggers and do not run
   `/positions`, `/risk` or `/filledorders` first. Submit a valid small market
   order. Verify the exchange fill, then check `/filledorders` and `/positions`.
   The order must be tracked without those commands starting the stream first.
6. In a separate local/testnet bot, remove or invalidate the account-stream
   configuration. Confirm a market preview. Expect an error before submission
   and no new exchange order. Restore configuration and create a new preview
   to verify recovery.

Do not share screenshots or logs containing API keys, signing secrets or bot
tokens.
