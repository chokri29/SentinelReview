use near_sdk::near;

#[near(contract_state)]
pub struct ExampleContract {
    value: u64,
    }

    #[near]
    impl ExampleContract {
        pub fn update_value(&mut self, new_value: u64) {
                self.value = new_value;
                    }
                    }
                    