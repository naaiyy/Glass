# Remote access

Remote access to an execution environment is not available in the Glass foundation.

The Glass architecture keeps cloud-owned projects, conversations, artifacts, and documents available without an execution environment. The foundation does not implement those durable product features yet. Machine actions such as opening workspace files, running terminals or agents, using Git, automating a browser, and creating workspace checkpoints require an authorized execution environment in a later milestone.

A later Glass Connect release provides managed remote access with explicit pairing, real user authentication, revocable scoped credentials, proof of possession, short-lived connection tickets, and encrypted managed transport. Glass never asks you to treat a bare tunnel URL or network location as authorization.

When an execution connection drops, Glass reports that environment as unavailable. The product connection remains separate, and Glass does not silently connect to a different machine or pretend an interrupted action completed.

This page gains setup and recovery instructions when the complete remote-access flow is shipped.
