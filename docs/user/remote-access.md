# Remote access

Remote access to a published execution environment is available through Glass Connect.

Cloud-owned projects, conversations, artifacts, and notes do not require an execution
environment. Machine actions such as opening workspace files, running terminals or commands, using
Git, and creating workspace checkpoints require an authorized execution environment through Glass
Connect.

Glass Connect provides managed remote access with explicit environment publishing,
real user authentication, revocable scoped credentials, proof of possession, short-lived connection
tickets, and encrypted managed transport through a Glass-managed per-environment Cloudflare Tunnel.
Signing in restores cloud access and reveals environments
you may use; it does not silently publish the current computer. On a capable computer, you
separately confirm **Publish this environment** to make it available to authorized devices in your
organization.

Glass Connect is the initial remote-execution experience. The execution node makes an outbound
connection; Glass provisions its address. It does not require SSH, a LAN address, Tailscale, a
user-managed tunnel, or a manually entered execution URL. Glass never asks you to treat a bare
tunnel URL or network location as authorization.

When an execution connection drops, Glass reports that environment as unavailable. The product connection remains separate, and Glass does not silently connect to a different machine or pretend an interrupted action completed.

The execution-node runbook contains maintainer setup and recovery instructions.
