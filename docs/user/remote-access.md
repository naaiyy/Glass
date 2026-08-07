# Remote access

Remote access to a published execution environment is available through Glass Connect.

Cloud-owned projects, conversations, artifacts, and notes do not require an execution
environment. Machine actions such as opening workspace files, running terminals or commands, using
Git, and creating workspace checkpoints require an authorized execution environment through Glass
Connect.

Glass Connect provides managed remote access with explicit environment publishing,
real user authentication, revocable scoped credentials, proof of possession, short-lived connection
tickets, and encrypted managed transport through a Glass-managed per-environment Cloudflare Tunnel.
Signing in restores cloud access and reveals environments you may use; it does not silently
publish the current computer.

To publish a computer, open a terminal in the folder you want to use and run
`npx glass-connect@latest`. It displays a one-time code and waits.
Open **Settings → Environments → Publish computer** on any signed-in Glass device and enter that
code. After approval, the same Glass Connect process publishes the computer, brings it online, and
stays connected. Running Glass Connect again resumes the saved publication.

That is the only choice during publishing: once published, the computer works with every project in
the organization and every supported machine capability. Publishing never asks for a host,
permissions or project access. Glass provisions and discovers the managed
connection address.

The Environments screen lists every published computer and labels it Online, Offline, Checking, or
Revoked. The app header shows a compact execution status and a permanent link to that screen. Open a
project and use its **Execution** card to choose a project folder. Glass discovers the folders shared
by online computers automatically; there is no separate load or attach workflow in Settings. Folder
selection tells Glass where that project can run. It is not a permissions step.

Glass Connect is the initial remote-execution experience. The execution node makes an outbound
connection; Glass provisions its address. It does not require SSH, a LAN address, Tailscale, a
user-managed tunnel, or a manually entered execution URL. Glass never asks you to treat a bare
tunnel URL or network location as authorization.

When an execution connection drops, Glass reports that environment as unavailable. The product connection remains separate, and Glass does not silently connect to a different machine or pretend an interrupted action completed.

The execution-node runbook contains maintainer setup and recovery instructions.
