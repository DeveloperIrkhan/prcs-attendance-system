// Who must approve a leave request.
//
//  Requester        up to 3 working days        more than 3 working days
//  STAFF (AD, SO…)  DD of the same department   Secretary General
//                   (or the HOD / an AD holding
//                   additional charge as acting
//                   HOD when there is no DD)
//  HOD              DD of the same department   Secretary General
//                   (or the Secretary General
//                   when there is no DD)
//  DD               Secretary General           Chairperson
//  Secretary General Chairperson                Chairperson
//  Chairperson      (nobody: Admin records it)  (nobody: Admin records it)
//
// Parent rights: a higher level may also decide anything routed to a lower level
// (DD over HOD requests in the same department, Secretary General over DD/HOD-level
// requests, Chairperson over every level).
//
// Department heads: a department is led by its DD. Departments that have no DD are led
// by their HOD, or by an AD given additional charge of that department (acting HOD), so
// short leave requests of their staff go there instead of being escalated to the Secretary General.

export type ApprovalLevel = "STAFF" | "HOD" | "DD" | "CEO" | "CHAIRMAN";
export type ApproverLevel = Exclude<ApprovalLevel, "STAFF">;

export const SHORT_ROUTE_MAX_DAYS = 3;

/** Every level that can approve something, lowest first. */
export const APPROVER_LEVELS = [
  "HOD",
  "DD",
  "CEO",
  "CHAIRMAN",
] as const satisfies readonly ApproverLevel[];

const RANK: Record<ApprovalLevel, number> = {
  STAFF: 0,
  HOD: 1,
  DD: 2,
  CEO: 3,
  CHAIRMAN: 4,
};

/** The highest of several levels. An acting CEO who is a DD by designation counts as CEO. */
export function highestLevel(levels: ApprovalLevel[]): ApprovalLevel {
  return levels.reduce<ApprovalLevel>(
    (best, l) => (RANK[l] > RANK[best] ? l : best),
    "STAFF",
  );
}

//the ones holding parent rights over it
export function levelsAbove(level: ApprovalLevel): ApproverLevel[] {
  return APPROVER_LEVELS.filter((l) => RANK[l] > RANK[level]);
}

/** HOD and DD both lead a department, so their approval is limited to that department. */
export function isDepartmentHeadLevel(level: ApprovalLevel | null): boolean {
  return level === "HOD" || level === "DD";
}

export type Route = {
  /** null: no one in the chain can approve (Chairperson's own leave) */
  approverLevel: ApproverLevel | null;
  /** true when only a department head (DD, or the HOD / acting HOD when there is no DD) may decide */
  sameDepartment: boolean;
};

export function resolveApprovalRoute(
  requesterLevel: ApprovalLevel,
  workingDays: number,
): Route {
  const short = workingDays <= SHORT_ROUTE_MAX_DAYS;
  switch (requesterLevel) {
    case "STAFF":
      return short
        ? { approverLevel: "DD", sameDepartment: true }
        : { approverLevel: "CEO", sameDepartment: false };
    case "HOD":
      // The HOD's own leave goes to the DD above them (or the Secretary General when
      // the department has no DD). Long leave always goes to the Secretary General.
      return short
        ? { approverLevel: "DD", sameDepartment: true }
        : { approverLevel: "CEO", sameDepartment: false };
    case "DD":
      return {
        approverLevel: short ? "CEO" : "CHAIRMAN",
        sameDepartment: false,
      };
    case "CEO":
      return { approverLevel: "CHAIRMAN", sameDepartment: false };
    case "CHAIRMAN":
      return { approverLevel: null, sameDepartment: false };
  }
}

export type ApproverIdentity = {
  employeeId: string;
  departmentId: string;
  /**
   * The level this person decides at: their designation's level, or the higher level they
   * act at while that post is vacant (acting CEO / Chairperson).
   */
  level: ApprovalLevel;
  /** other departments this DD also looks after (additional charge) */
  chargeDepartmentIds?: string[];
  /**
   * Departments where this person acts as HOD through additional charge. An AD's designation
   * is STAFF, but an AD holding charge of a department with no DD is its department head.
   */
  actingHodDepartmentIds?: string[];
};

export type RoutedRequest = {
  employeeId: string; // the requester
  approverLevel: ApprovalLevel | null;
  approverDepartmentId: string | null;
};

/**
 * May this person approve or reject this request?
 * - nobody decides their own request
 * - the level the request is routed to may decide (a department head only inside their
 *   own department, or one they hold additional charge of)
 * - any higher level may decide too (parent rights), but a department head only has those
 *   rights inside their department
 */
export function canDecideRequest(
  approver: ApproverIdentity | null,
  request: RoutedRequest,
): boolean {
  if (!approver) return false;
  if (approver.employeeId === request.employeeId) return false;
  if (!request.approverLevel || request.approverLevel === "STAFF") return false;

  // An AD (STAFF designation) holding additional charge of a department acts as its HOD.
  // They decide HOD-level requests for that department only, never their own AD requests
  // and never requests routed to DD level.
  if (approver.level === "STAFF") {
    return (
      request.approverLevel === "HOD" &&
      request.approverDepartmentId !== null &&
      (approver.actingHodDepartmentIds ?? []).includes(
        request.approverDepartmentId,
      )
    );
  }

  const inDepartment =
    request.approverDepartmentId !== null &&
    (approver.departmentId === request.approverDepartmentId ||
      (approver.chargeDepartmentIds ?? []).includes(
        request.approverDepartmentId,
      ) ||
      (approver.actingHodDepartmentIds ?? []).includes(
        request.approverDepartmentId,
      ));
  const departmentScoped = isDepartmentHeadLevel(request.approverLevel);

  if (RANK[approver.level] > RANK[request.approverLevel]) {
    // A DD (or HOD) acting above a department-level request only decides for their own
    // department. The Secretary General and the Chairperson decide for every department.
    if (departmentScoped && isDepartmentHeadLevel(approver.level)) {
      return inDepartment;
    }
    return true;
  }
  if (approver.level !== request.approverLevel) return false;

  if (departmentScoped) {
    return inDepartment;
  }
  return true;
}

export const APPROVER_LABEL: Record<ApproverLevel, string> = {
  HOD: "Department HOD",
  DD: "Department DD",
  CEO: "Secretary General",
  CHAIRMAN: "Chairperson",
};
