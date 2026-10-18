import { describe, expect, it } from 'vitest';
import { splitMessage } from '../src/components/Message.tsx';

describe('a message as a title and detail', () => {
  it('takes the first sentence as the title, without its full stop', () => {
    expect(splitMessage('This question doesn’t exist. It may have been deleted.')).toEqual({ title: 'This question doesn’t exist', detail: 'It may have been deleted.' });
    expect(splitMessage('There’s no one with that name.')).toEqual({ title: 'There’s no one with that name' });
    expect(splitMessage('Questions couldn’t load')).toEqual({ title: 'Questions couldn’t load' });
  });
});
