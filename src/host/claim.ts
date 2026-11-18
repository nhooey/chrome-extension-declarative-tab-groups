// How one host, of any number started at once, comes to serve the socket,
// and how it lets go. The steps go through `SocketEdge`, which `host.ts`
// carries out on the file system and a test carries out on a model, so a
// test can interleave several hosts' steps in every order.
//
// Each host first makes a claim: a Unix socket of its own, beside the
// socket, under a name no other host uses, which appears under that name
// only once it listens. A claim that refuses a connection belongs to a
// host that has gone, and any host may remove it; one that answers
// belongs to a live host. A host serves only when no other claim answers,
// and only the host that serves touches the socket's path. Since every
// host makes its claim before it looks at the others', two hosts cannot
// both miss each other: of hosts started together at most one serves, and
// possibly none, in which case the extension connects again later. A host
// closes the socket, which removes its path, before its claim, so no
// other host can have bound the path in between.

/** What a connection to a claim or to the socket found. */
export type Probe = "answered" | "refused" | "gone";

/** What is at the socket's path. */
export type PathKind = "absent" | "socket" | "other";

export type Bind =
  | { readonly kind: "bound" }
  | { readonly kind: "in-use" }
  | { readonly kind: "problem"; readonly message: string };

/** The steps of claiming, serving and letting go, each one atomic. */
export type SocketEdge = {
  /** Makes this host's claim, listening before it is visible; resolves to its name. */
  readonly createClaim: () => Promise<string>;
  /** The names of every claim beside the socket, this host's included. */
  readonly listClaims: () => Promise<readonly string[]>;
  readonly probeClaim: (name: string) => Promise<Probe>;
  /** Removes a claim that refused a connection. */
  readonly removeClaim: (name: string) => Promise<void>;
  /** Stops listening on this host's claim and removes it. */
  readonly closeClaim: () => Promise<void>;
  readonly inspectSocket: () => Promise<PathKind>;
  readonly probeSocket: () => Promise<Probe>;
  /** Removes a socket that refused a connection. */
  readonly removeSocket: () => Promise<void>;
  readonly bindSocket: () => Promise<Bind>;
  /** Stops serving the socket, which removes its path. */
  readonly closeSocket: () => Promise<void>;
};

/** The longest name a claim adds to the socket's path: `.` and 8 hex digits, then `.claim`. */
export const CLAIM_SUFFIX_BYTES = 15;

/** Whether this host may serve, given what each other claim answered. */
export const mayServe = (others: readonly Probe[]): boolean =>
  !others.includes("answered");

/** What to do about the socket's path before binding it, given what is there. */
export const socketStep = (
  kind: PathKind,
  probe: Probe | null,
): "bind" | "remove-then-bind" | "in-use" | "not-a-socket" =>
  kind === "absent"
    ? "bind"
    : kind === "other"
      ? "not-a-socket"
      : probe === "answered"
        ? "in-use"
        : probe === "refused"
          ? "remove-then-bind"
          : "bind";

/**
 * Claims the socket and binds it, or finds another host serving it. Every
 * outcome but `bound` has let go of this host's claim.
 */
export const claimSocket = async (edge: SocketEdge): Promise<Bind> => {
  const own = await edge.createClaim();
  const others = (await edge.listClaims()).filter((name) => name !== own);
  const probes: Probe[] = [];
  for (const name of others) {
    const probe = await edge.probeClaim(name);
    if (probe === "refused") {
      await edge.removeClaim(name);
    }
    probes.push(probe);
  }
  const outcome = await (async (): Promise<Bind> => {
    if (!mayServe(probes)) {
      return { kind: "in-use" };
    }
    const kind = await edge.inspectSocket();
    const step = socketStep(
      kind,
      kind === "socket" ? await edge.probeSocket() : null,
    );
    switch (step) {
      case "in-use":
        return { kind: "in-use" };
      case "not-a-socket":
        return { kind: "problem", message: "it exists and is not a socket" };
      case "remove-then-bind":
        await edge.removeSocket();
        return edge.bindSocket();
      case "bind":
        return edge.bindSocket();
    }
  })();
  if (outcome.kind !== "bound") {
    await edge.closeClaim();
  }
  return outcome;
};

/** Lets go of a bound socket: the socket first, then the claim that guarded it. */
export const releaseSocket = async (edge: SocketEdge): Promise<void> => {
  await edge.closeSocket();
  await edge.closeClaim();
};
