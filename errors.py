class DataTalkError(Exception):
    """Base exception class for Data Talk."""
    def __init__(self, message, status_code=500, error_type="server_error"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_type = error_type

class AuthenticationError(DataTalkError):
    def __init__(self, message="Authentication failed"):
        super().__init__(message, status_code=401, error_type="auth_error")

class DatasetNotFoundError(DataTalkError):
    def __init__(self, message="Dataset not found"):
        super().__init__(message, status_code=404, error_type="file_not_found")

class LLMServiceError(DataTalkError):
    def __init__(self, message="Error communicating with LLM service"):
        super().__init__(message, status_code=502, error_type="gemini_error")

class CodeExecutionError(DataTalkError):
    def __init__(self, message="Error executing analysis code"):
        super().__init__(message, status_code=500, error_type="analysis_error")

class ValidationError(DataTalkError):
    def __init__(self, message="Validation error"):
        super().__init__(message, status_code=400, error_type="validation_error")

class DataProcessingError(DataTalkError):
    def __init__(self, message="Error processing data"):
        super().__init__(message, status_code=500, error_type="processing_error")
