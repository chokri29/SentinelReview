#[near]
impl Contract {
    pub fn on_callback(#[callback_result] result: Result<(), PromiseError>) {
        self.completed = true;
    }
}
