import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from './App';

test('identifies the application', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Jukelet' })).toBeInTheDocument();
});
