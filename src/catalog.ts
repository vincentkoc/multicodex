export type IdeaCard = {
  id: string;
  title: string;
  pitch: string;
  demoMoment: string;
  minPeople: number;
  maxPeople: number;
  roles: string[];
  acceptanceCriteria: string[];
};

export type RoleCard = {
  id: string;
  label: string;
  mission: string;
  owns: string[];
  color: string;
  suitableForAISeat: boolean;
};

export const ideas: IdeaCard[] = [
  {
    id: "audience-voting-wall",
    title: "Audience voting wall",
    pitch: "A live wall where a room proposes, votes, and watches the winner change in real time.",
    demoMoment: "The wall flips winners while the audience votes from their phones.",
    minPeople: 2,
    maxPeople: 5,
    roles: ["product-integration", "design-frontend", "backend-data", "quality-demo"],
    acceptanceCriteria: ["create a poll", "cast votes", "show a live winner", "present a polished wall"],
  },
  {
    id: "hallway-matchmaker",
    title: "Hallway matchmaker",
    pitch: "A fast conference tool that pairs people by what they want to learn and teach.",
    demoMoment: "Four attendees enter one phrase each and receive a surprising useful match.",
    minPeople: 2,
    maxPeople: 4,
    roles: ["product-integration", "design-frontend", "backend-data", "quality-demo"],
    acceptanceCriteria: ["add an attendee", "rank matches", "explain the match", "reset the room"],
  },
  {
    id: "latency-race",
    title: "Visual API latency race",
    pitch: "Race several public APIs and turn response time into a tiny live sporting event.",
    demoMoment: "The leaderboard animates as providers finish in a different order.",
    minPeople: 2,
    maxPeople: 4,
    roles: ["product-integration", "design-frontend", "backend-data", "quality-demo"],
    acceptanceCriteria: ["start a race", "stream results", "show errors clearly", "replay a race"],
  },
  {
    id: "recursive-hackathon",
    title: "Hackathon planner planner",
    pitch: "A tiny tool that turns a theme and team size into a buildable five-minute plan.",
    demoMoment: "The tool proposes the plan for the tool currently being demonstrated.",
    minPeople: 2,
    maxPeople: 5,
    roles: ["product-integration", "design-frontend", "backend-data", "quality-demo"],
    acceptanceCriteria: ["enter a theme", "generate roles", "show a task graph", "export a plan"],
  },
];

export const roles: RoleCard[] = [
  {
    id: "product-integration",
    label: "Product + integration",
    mission: "Keep the promise small, contracts explicit, and the final branch running.",
    owns: ["README.md", "shared contracts", "integration"],
    color: "#e24a33",
    suitableForAISeat: false,
  },
  {
    id: "design-frontend",
    label: "Design + frontend",
    mission: "Make the first interaction obvious and the final demo worth looking at.",
    owns: ["src/client", "visual states", "preview"],
    color: "#2563eb",
    suitableForAISeat: false,
  },
  {
    id: "backend-data",
    label: "Backend + data",
    mission: "Build the smallest reliable API and data model that supports the demo.",
    owns: ["src/api", "storage", "contracts"],
    color: "#16825d",
    suitableForAISeat: true,
  },
  {
    id: "quality-demo",
    label: "Quality + demo",
    mission: "Break the risky path early, tighten the story, and own the final rehearsal.",
    owns: ["tests", "fixtures", "demo runbook"],
    color: "#d99b16",
    suitableForAISeat: true,
  },
  {
    id: "wildcard-prototype",
    label: "Wildcard prototype",
    mission: "Build one memorable experimental detail without blocking the core.",
    owns: ["prototype"],
    color: "#8b5cf6",
    suitableForAISeat: true,
  },
];

export function chooseIdea(seed: string, people: number): IdeaCard {
  const compatible = ideas.filter((idea) => people >= idea.minPeople && people <= idea.maxPeople);
  const total = [...seed].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return compatible[total % compatible.length] ?? ideas[0]!;
}

export function rolesForSeats(count: number): RoleCard[] {
  return Array.from({ length: count }, (_, index) => roles[index % roles.length]!);
}
