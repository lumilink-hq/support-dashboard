"use client";

// A submit button that asks first. For irreversible form actions in server
// components (e.g. Remove on /team, which deletes the login for good): the
// form stays a plain server-action form, and this only cancels the submit
// when the person says no.
export function ConfirmSubmit({
  message,
  className,
  children,
}: {
  message: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
