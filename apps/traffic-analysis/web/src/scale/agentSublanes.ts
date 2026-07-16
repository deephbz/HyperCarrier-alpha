export type AgentSublanes = {
  agentRef: string;
  bandLeft: number;
  bandRight: number;
  boundaryX: number;
  observedX: number;
};

/** Two, and only two, visible x positions belong to each agent band. */
export const agentSublanes = (
  agentRefs: readonly string[],
  left: number,
  right: number,
): AgentSublanes[] => {
  const width = Math.max(1, right - left);
  const bandWidth = width / Math.max(1, agentRefs.length);
  return agentRefs.map((agentRef, index) => {
    const bandLeft = left + index * bandWidth;
    return {
      agentRef,
      bandLeft,
      bandRight: bandLeft + bandWidth,
      boundaryX: bandLeft + bandWidth * 0.32,
      observedX: bandLeft + bandWidth * 0.7,
    };
  });
};
