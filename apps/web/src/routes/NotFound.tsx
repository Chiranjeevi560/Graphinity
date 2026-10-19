import { MessageScreen } from '../components/Message.tsx';

export default function NotFound() {
  return (
    <MessageScreen title="This page doesn’t exist" detail="Check the address, or start again from the home page." />
  );
}
