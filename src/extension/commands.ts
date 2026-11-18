// The extension's answer to each command. Nothing throws out of
// `handleRequest`: every fault becomes a failure response.

import {
  type Failure,
  failure,
  type GetRequest,
  type Request,
  type Response,
  type SetRequest,
} from "../protocol/index.ts";
import { plan } from "./plan.ts";
import {
  groupsTitled,
  readGroupState,
  tabKind,
  tabsOf,
  tabUrl,
} from "./read-state.ts";
import { runPlan } from "./run-plan.ts";
import { type Edge, messageOf, within } from "./tab-strip.ts";

/** The versions `status` reports. */
export type Versions = { readonly extension: string; readonly chrome: string };

/** What the commands act through: the edge, and a way to read the versions. */
export type Services = Edge & { readonly versions: () => Promise<Versions> };

const ambiguous = (count: number, title: string) =>
  failure(
    "ambiguous-group",
    `${count} tab groups are titled ${JSON.stringify(title)}`,
  );

/** How long a request may take before it is answered `internal` and its group's queue moves on; under the host's own limit of 120 seconds. */
export const REQUEST_DEADLINE_MS = 90_000;

/**
 * The failure for a `set` whose list holds a file URL while the user has
 * not allowed the extension file URLs, since Chrome would refuse to open
 * it after the old pages had begun to close; null otherwise.
 */
const fileAccessFailure = async (
  services: Services,
  request: SetRequest,
): Promise<Failure | null> => {
  const index = request.urls.findIndex(
    (url) => URL.parse(url)?.protocol === "file:",
  );
  return index === -1 ||
    (await services.tabStrip.extension.isAllowedFileSchemeAccess())
    ? null
    : failure(
        "invalid-request",
        `field "urls[${index}]" is a file URL, and the extension's "Allow access to file URLs" setting is off`,
      );
};

const setGroup = async (
  services: Services,
  request: SetRequest,
): Promise<Response> => {
  const refused = await fileAccessFailure(services, request);
  if (refused !== null) {
    return refused;
  }
  const planned = plan(await readGroupState(services, request.group), request);
  return planned.ok
    ? runPlan(services, request.group, planned.value)
    : planned.error;
};

const getGroup = async (
  services: Services,
  request: GetRequest,
): Promise<Response> => {
  const groups = await groupsTitled(services.tabStrip, request.group);
  const [group, ...others] = groups;
  if (group === undefined) {
    return failure(
      "no-group",
      `no tab group is titled ${JSON.stringify(request.group)}`,
    );
  }
  if (others.length > 0) {
    return ambiguous(groups.length, request.group);
  }
  const tabs = await tabsOf(services.tabStrip, group.id);
  return {
    protocol: 1,
    ok: true,
    command: "get",
    group: { title: request.group, windowId: group.windowId },
    tabs: tabs
      .map((tab) => ({ url: tabUrl(tab), title: tab.title ?? "" }))
      .filter((tab) => tabKind(tab.url, services.pages) === "other"),
  };
};

const answer = async (
  services: Services,
  request: Request,
): Promise<Response> => {
  try {
    switch (request.command) {
      case "set":
        return await setGroup(services, request);
      case "get":
        return await getGroup(services, request);
      case "status":
        return {
          protocol: 1,
          ok: true,
          command: "status",
          ...(await services.versions()),
        };
    }
  } catch (error) {
    return failure(
      "internal",
      `the extension failed to answer: ${messageOf(error)}`,
    );
  }
};

/**
 * The response to one request, or `internal` once `REQUEST_DEADLINE_MS`
 * has passed without one. A request still running then is given up through
 * its edge's signal: it makes no Chrome call after the one under way
 * returns, so it cannot act on its group alongside the next request.
 */
export const handleRequest = async (
  services: Services,
  request: Request,
): Promise<Response> => {
  const deadline = new AbortController();
  try {
    return await within(
      services.clock,
      REQUEST_DEADLINE_MS,
      answer({ ...services, signal: deadline.signal }, request),
      failure(
        "internal",
        `the extension did not answer within ${REQUEST_DEADLINE_MS / 1000} seconds`,
      ),
    );
  } finally {
    deadline.abort(
      new Error(
        `the request passed its deadline of ${REQUEST_DEADLINE_MS / 1000} seconds`,
      ),
    );
  }
};

/**
 * The queue a request waits in: its group's title, since requests on one
 * group run one at a time in arrival order; null for `status`, which
 * touches no group.
 */
export const queueKey = (request: Request): string | null =>
  request.command === "status" ? null : request.group;
