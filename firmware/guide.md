# Muse Relay on AtomS3 and AtomS3 Lite

Muse Relay is a shared Even Hub app configured with each user's own relay.
This ATOM S3 is one optional reference implementation. Gist users do not need
an ATOM S3. This guide describes this device's configured role.

This stationary, USB-powered ATOM S3 relays requests from the user's Even G2
app to Muse through the paired Gadget SDK connection. A user-hosted HTTPS
queue connects the phone outside the home to this device's outbound poll.

The device has no active microphone, speaker, display interface or home-network
tunnel in this build. The Even G2 app handles input and presents replies.
Voice requests arrive as WAV attachments; Muse handles transcription.
Space reading is a user-configured request for a Muse-created Space adapter.

Press the front button to confirm pairing. Holding it for five seconds clears
pairing and Wi-Fi. The USB serial console reports connection/setup state.
On the AtomS3 Lite, steady red indicates loss of network access, blinking
amber indicates that Muse is disconnected, and green indicates a ready
connection. Blue blinks while forwarding a request or waiting for Muse.
Steady purple indicates that the device is relaying a reply.
Unplug and reconnect USB power to restart. The device processes one request
at a time; a timed-out request is reported and never replayed automatically.

Firmware 0.1.4 also accepts an authenticated update offer from its configured
HTTPS relay between requests. See the [device update contract](../docs/atoms3.md#firmware-updates-from-your-relay)
for board targets, binary delivery, rollback and confirmation.
