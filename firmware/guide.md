# Muse Relay on ATOM S3

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
Unplug and reconnect USB power to restart. The device processes one request
at a time; a timed-out request is reported and never replayed automatically.
