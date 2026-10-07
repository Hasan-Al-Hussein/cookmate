import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text, View } from 'react-native';
import { catalogue, getRecipe, type CatalogueRecipe } from '@cookmate/catalogue';
import type {
  CookingService,
  CookingSession,
  CookingSessionView,
  Immutable,
} from '@cookmate/domain';
import { CookingReader } from './CookingReader';
import { InstructionPassageView } from './InstructionPassageView';

const mockWorkspace = jest.fn();
let mockId = 0;
jest.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => `a0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../cooking/KeepAwakeControl', () => ({ KeepAwakeControl: () => null }));
jest.mock('../cooking/CookingCompletion', () => ({ CookingCompletion: () => null }));

const recipe = getRecipe('52819')!;
const timestamp = '2026-10-01T01:36:43Z';
const content = {
  recipeId: recipe.recipeId,
  catalogue: catalogue.identity,
  contentFingerprint: 'a'.repeat(64),
  readerVersion: 1 as const,
};
const session: Immutable<CookingSession> = {
  ...content,
  sessionId: 'b0000000-0000-4000-8000-000000000001',
  revision: 1,
  passageSequence: 1,
  state: 'active',
  updatedAt: timestamp,
  lastOperationId: 'c0000000-0000-4000-8000-000000000001',
};
let mockView: Immutable<CookingSessionView>;
const saveSession = jest.fn<
  ReturnType<CookingService['saveSession']>,
  Parameters<CookingService['saveSession']>
>();
const readSession = jest.fn<
  ReturnType<CookingService['readSession']>,
  Parameters<CookingService['readSession']>
>();

function fullInstructions(value: CatalogueRecipe) {
  return (
    <View>
      {value.instructions.map((passage) => (
        <InstructionPassageView key={passage.sequence} recipe={value} passage={passage} />
      ))}
    </View>
  );
}
function reader(value = recipe) {
  return (
    <CookingReader
      recipe={value}
      visible
      onClose={jest.fn()}
      onDismiss={jest.fn()}
      ingredients={<Text>Original ingredient fixture</Text>}
      ingredientNotes={null}
      sourceNotes={null}
      fullInstructions={fullInstructions(value)}
    />
  );
}

beforeEach(() => {
  mockId = 0;
  mockView = {
    currentContent: content,
    session,
    resume: 'matching',
    passageSequences: [1, 2, 3, 4, 5],
  };
  readSession.mockImplementation(async () => ({ kind: 'ready', value: mockView, revision: 1 }));
  saveSession.mockImplementation(async (input) => ({
    kind: 'ready',
    revision: 2,
    value: {
      ...session,
      sessionId: input.sessionId,
      passageSequence: input.passageSequence,
      revision: (input.expectedRevision ?? 0) + 1,
      lastOperationId: input.operationId,
    },
  }));
  mockWorkspace.mockReturnValue({
    availability: {
      kind: 'ready',
      services: {
        cooking: { readSession, saveSession },
        queries: { readInstallationId: jest.fn() },
      },
    },
    clock: { now: () => timestamp },
  });
});
afterEach(cleanup);

test('full instructions retain every original passage with explicit reviewed labels', () => {
  render(fullInstructions(recipe));
  expect(screen.getByText('About this recipe')).toBeTruthy();
  for (const passage of recipe.instructions) expect(screen.getByText(passage.rawText)).toBeTruthy();
  for (let index = 1; index <= 4; index++)
    expect(screen.getByText(`Cooking passage ${index} of 4`)).toBeTruthy();
});

test('the introductory saved anchor resumes unchanged and only deliberate Start cooking saves passage 2', async () => {
  const view = render(reader());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start cooking' })).toBeEnabled());
  expect(screen.getByText('About this recipe')).toBeTruthy();
  expect(screen.getByText(recipe.instructions[0]!.rawText)).toBeTruthy();
  expect(screen.queryByText('The recipe has changed')).toBeNull();
  expect(saveSession).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Start cooking' }));
  await waitFor(() => expect(saveSession).toHaveBeenCalledTimes(1));
  expect(saveSession.mock.calls[0]![0].passageSequence).toBe(2);
  expect(screen.getByText('Cooking passage 1 of 4')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Open ingredients sheet' }));
  expect(screen.getByText('Original ingredient fixture')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Close ingredients sheet' }));
  expect(screen.getByText('Cooking passage 1 of 4')).toBeTruthy();
  expect(saveSession).toHaveBeenCalledTimes(1);
  view.unmount();
});

test('a procedural saved anchor resumes without relabelling it as passage 1 or saving automatically', async () => {
  mockView = { ...mockView, session: { ...session, passageSequence: 4 } };
  render(reader());
  await waitFor(() => expect(screen.getByText('Cooking passage 3 of 4')).toBeTruthy());
  expect(screen.getByText(recipe.instructions[3]!.rawText)).toBeTruthy();
  expect(saveSession).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Full instructions' }));
  for (const passage of recipe.instructions) expect(screen.getByText(passage.rawText)).toBeTruthy();
  expect(saveSession).not.toHaveBeenCalled();
});

test('a source mismatch falls back to original neutral sections and preserves its text', async () => {
  const changed: CatalogueRecipe = {
    ...recipe,
    instructions: [
      { ...recipe.instructions[0], rawText: `${recipe.instructions[0].rawText} Changed fixture.` },
      ...recipe.instructions.slice(1),
    ],
  };
  render(reader(changed));
  await waitFor(() => expect(screen.getByText('Section 1 of 5')).toBeTruthy());
  expect(screen.queryByText('About this recipe')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Start cooking' })).toBeNull();
  expect(screen.getByText(changed.instructions[0]!.rawText)).toBeTruthy();
  expect(saveSession).not.toHaveBeenCalled();
});
