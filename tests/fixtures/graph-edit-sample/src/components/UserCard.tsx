import type { FC } from "react";

export interface UserCardProps {
  id: string;
  name: string;
}

/**
 * @public
 * Card component rendering a user's basic identity.
 */
export const UserCard: FC<UserCardProps> = ({ id, name }) => {
  return (
    <div className="user-card" data-id={id}>
      <span>{name}</span>
    </div>
  );
};
