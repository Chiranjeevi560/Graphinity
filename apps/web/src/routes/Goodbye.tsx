import { MessageScreen } from '../components/Message.tsx';

export default function Goodbye() {
  return (
    <MessageScreen
      title="Your account is deleted"
      detail="Your profile and everything you shared have been removed, and you’re signed out."
    />
  );
}
