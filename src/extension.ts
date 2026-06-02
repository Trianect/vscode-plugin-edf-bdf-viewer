import * as vscode from 'vscode';
import { EdfPreviewProvider } from './edfPreviewProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(EdfPreviewProvider.register(context));
}

export function deactivate(): void {}
