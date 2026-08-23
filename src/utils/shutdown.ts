let shuttingDown = false;

/** Marca que el proceso está en shutdown intencional (deploy/SIGTERM). */
export const markShuttingDown = (): void => {
  shuttingDown = true;
};

/** true si el proceso se está apagando: desconexiones esperadas, sin notificar. */
export const isShuttingDown = (): boolean => shuttingDown;
