import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ItemLabel, type Item } from './music';

const item: Item = { uri: 'spotify:album:0123456789ABCDEFGHIJKL', media_type: 'album', title: 'Synthetic album', subtitle: 'Synthetic artist', artwork_url: 'https://i.scdn.co/image/synthetic' };

test.each(['album', 'playlist'] as const)('attributes %s metadata and artwork with a canonical Spotify content link', media_type => {
  render(<ItemLabel item={{ ...item, media_type, uri: item.uri.replace('album', media_type) }} />);
  const link = screen.getByRole('link', { name: `Open Synthetic album on Spotify` });
  expect(link).toHaveAttribute('href', `https://open.spotify.com/${media_type}/0123456789ABCDEFGHIJKL`);
  expect(link).toHaveAttribute('rel', 'noreferrer');
  expect(screen.getByRole('img', { name: 'Spotify' })).toHaveAttribute('src', '/spotify-logo-black.svg');
  expect(screen.getByRole('img', { name: 'Artwork for Synthetic album' })).toHaveAttribute('referrerpolicy', 'no-referrer');
});

test.each(['https://private.example/', 'javascript:alert(1)', 'spotify:track:0123456789ABCDEFGHIJKL', 'spotify:playlist:0123456789ABCDEFGHIJKL'])('does not turn unsupported or mismatched content %s into an external link', uri => {
  render(<ItemLabel item={{ ...item, uri }} />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
